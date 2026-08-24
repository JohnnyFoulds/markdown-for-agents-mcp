#!/usr/bin/env bash
# ECS Fargate deployment script for markdown-mcp.
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials
#   - Docker logged in to ECR: aws ecr get-login-password | docker login ...
#   - CloudWatch log groups created (or use --create-if-not-exists)
#   - ALB, target group, VPC, subnets, and security groups already provisioned
#
# Usage:
#   export AWS_ACCOUNT_ID=123456789012
#   export AWS_REGION=eu-west-1
#   export ECS_CLUSTER_ARN=arn:aws:ecs:...
#   export ECR_REPO=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/markdown-mcp
#   export IMAGE_TAG=$(git rev-parse --short HEAD)
#   ./deploy.sh
#
# After first deploy, wire up Application Auto Scaling manually via the AWS
# console or using the target/policy payloads in scaling.json.

set -euo pipefail

: "${AWS_ACCOUNT_ID:?}"
: "${AWS_REGION:?}"
: "${ECS_CLUSTER_ARN:?}"
: "${ECR_REPO:?}"
: "${IMAGE_TAG:?}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Substitute all <PLACEHOLDER> values in the JSON/YAML templates
render() {
  sed \
    -e "s|<AWS_ACCOUNT_ID>|${AWS_ACCOUNT_ID}|g" \
    -e "s|<AWS_REGION>|${AWS_REGION}|g" \
    -e "s|<IMAGE_TAG>|${IMAGE_TAG}|g" \
    "$@"
}

echo "==> Building and pushing image ${ECR_REPO}:${IMAGE_TAG}"
docker build -t "${ECR_REPO}:${IMAGE_TAG}" \
  --build-arg PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  "${SCRIPT_DIR}/../.."
docker push "${ECR_REPO}:${IMAGE_TAG}"

echo "==> Uploading ADOT config to SSM"
aws ssm put-parameter \
  --region "${AWS_REGION}" \
  --name "/markdown-mcp/adot-config" \
  --value "$(cat "${SCRIPT_DIR}/adot-config.yaml" | sed "s|<AWS_REGION>|${AWS_REGION}|g; s|<ECS_CLUSTER_NAME>|${ECS_CLUSTER_NAME:-markdown-mcp}|g")" \
  --type SecureString \
  --overwrite

echo "==> Registering task definition: server"
SERVER_TD_ARN=$(
  render "${SCRIPT_DIR}/task-definition-server.json" \
  | aws ecs register-task-definition \
      --region "${AWS_REGION}" \
      --cli-input-json file:///dev/stdin \
      --query 'taskDefinition.taskDefinitionArn' \
      --output text
)
echo "    ${SERVER_TD_ARN}"

echo "==> Registering task definition: worker"
WORKER_TD_ARN=$(
  render "${SCRIPT_DIR}/task-definition-worker.json" \
  | aws ecs register-task-definition \
      --region "${AWS_REGION}" \
      --cli-input-json file:///dev/stdin \
      --query 'taskDefinition.taskDefinitionArn' \
      --output text
)
echo "    ${WORKER_TD_ARN}"

update_or_create_service() {
  local svc_json="$1"
  local svc_name="$2"
  local td_arn="$3"

  local exists
  exists=$(aws ecs describe-services \
    --region "${AWS_REGION}" \
    --cluster "${ECS_CLUSTER_ARN}" \
    --services "${svc_name}" \
    --query 'length(services[?status!=`INACTIVE`])' \
    --output text 2>/dev/null || echo 0)

  if [ "${exists}" -gt 0 ]; then
    echo "==> Updating service: ${svc_name}"
    aws ecs update-service \
      --region "${AWS_REGION}" \
      --cluster "${ECS_CLUSTER_ARN}" \
      --service "${svc_name}" \
      --task-definition "${td_arn}" \
      --force-new-deployment \
      --output text --query 'service.serviceName'
  else
    echo "==> Creating service: ${svc_name}"
    render "${svc_json}" \
      | sed "s|<ECS_CLUSTER_ARN>|${ECS_CLUSTER_ARN}|g" \
      | aws ecs create-service \
          --region "${AWS_REGION}" \
          --cli-input-json file:///dev/stdin \
          --output text --query 'service.serviceName'
  fi
}

update_or_create_service \
  "${SCRIPT_DIR}/service-server.json" "markdown-mcp-server" "${SERVER_TD_ARN}"

update_or_create_service \
  "${SCRIPT_DIR}/service-worker.json" "markdown-mcp-worker" "${WORKER_TD_ARN}"

echo "==> Waiting for server service to stabilize (readyz gate)…"
aws ecs wait services-stable \
  --region "${AWS_REGION}" \
  --cluster "${ECS_CLUSTER_ARN}" \
  --services "markdown-mcp-server"

echo "==> Deployment complete."
echo ""
echo "Post-deploy checklist:"
echo "  1. Verify /dev/shm is 1 GB:  aws ecs execute-command ... -- cat /proc/mounts | grep shm"
echo "  2. Confirm metrics in CloudWatch:  ECS/ContainerInsights/Prometheus namespace"
echo "  3. Wire Application Auto Scaling policies if not yet done (see scaling.json)"
echo "  4. Raise ALB idle timeout to 120 s if not already set"
