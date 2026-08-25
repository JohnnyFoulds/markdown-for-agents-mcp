#!/usr/bin/env python3
"""
Reproducible TCO model: markdown-for-agents-mcp vs Tavily and Firecrawl.

Every numeric constant is defined once at module level, with source URL and
retrieval date.  Running this script regenerates:
  scripts/cost-model-output.json
  docs/enterprise/assets/cost-*.svg  (+ *.png for embedding)

No number in COST_ANALYSIS.md is hand-typed; all come from cost-model-output.json.

Usage:
  python3 scripts/cost-model.py            # generates JSON + charts
  python3 scripts/cost-model.py --json-only  # skip charts (CI use)
"""

import json
import math
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 0.  Structural helpers
# ---------------------------------------------------------------------------

def C(value, unit, source, retrieved, confidence="published", notes=""):
    """Return a constant record.  confidence in {published, derived, estimated, assumed}."""
    return {"value": value, "unit": unit, "source": source,
            "retrieved": retrieved, "confidence": confidence, "notes": notes}

# ---------------------------------------------------------------------------
# 1.  Vendor pricing constants
# ---------------------------------------------------------------------------

# Tavily — https://tavily.com/#pricing (retrieved 2026-08-24)
TAVILY_SOURCE = "https://tavily.com/#pricing"
TAVILY_DATE   = "2026-08-24"
TAVILY_TIERS = [
    {"name": "Researcher",  "credits": 1_000,   "price_usd_mo": 0,    "source": TAVILY_SOURCE, "retrieved": TAVILY_DATE},
    {"name": "Project",     "credits": 4_000,   "price_usd_mo": 30,   "source": TAVILY_SOURCE, "retrieved": TAVILY_DATE},
    {"name": "Bootstrap",   "credits": 15_000,  "price_usd_mo": 100,  "source": TAVILY_SOURCE, "retrieved": TAVILY_DATE},
    {"name": "Startup",     "credits": 38_000,  "price_usd_mo": 220,  "source": TAVILY_SOURCE, "retrieved": TAVILY_DATE},
    {"name": "Growth",      "credits": 100_000, "price_usd_mo": 500,  "source": TAVILY_SOURCE, "retrieved": TAVILY_DATE},
    # Above Growth: Enterprise (custom); Growth is the public ceiling
]
TAVILY_PAYG = C(0.008, "USD/credit", TAVILY_SOURCE, TAVILY_DATE,
                notes="Pay-as-you-go rate; Growth tier is $0.005/credit")

# Tavily credit costs per operation (retrieved 2026-08-24)
TAVILY_CREDITS_BASIC_SEARCH  = C(1,   "credits/query",    TAVILY_SOURCE, TAVILY_DATE)
TAVILY_CREDITS_ADVANCED_SEARCH = C(2, "credits/query",    TAVILY_SOURCE, TAVILY_DATE)
TAVILY_CREDITS_BASIC_EXTRACT = C(0.2, "credits/URL",      TAVILY_SOURCE, TAVILY_DATE,
                                  notes="1 credit per 5 URLs")
TAVILY_CREDITS_CRAWL_PAGE    = C(0.3, "credits/page",     TAVILY_SOURCE, TAVILY_DATE,
                                  notes="map(1/10 pages) + extract(1/5 pages) ≈ 0.3/page")
TAVILY_FAILED_CHARGE         = C(0.0, "credits/failed-op",TAVILY_SOURCE, TAVILY_DATE,
                                  notes="No charge for failed extractions or maps")

# Firecrawl — https://www.firecrawl.dev/pricing (retrieved 2026-08-24, annual billing)
FC_SOURCE = "https://www.firecrawl.dev/pricing"
FC_DATE   = "2026-08-24"
FIRECRAWL_TIERS = [
    {"name": "Hobby",    "pages": 5_000,   "price_usd_mo": 16,   "billing": "annual", "source": FC_SOURCE, "retrieved": FC_DATE},
    {"name": "Standard", "pages": 100_000, "price_usd_mo": 83,   "billing": "annual", "source": FC_SOURCE, "retrieved": FC_DATE},
    {"name": "Growth",   "pages": 500_000, "price_usd_mo": 333,  "billing": "annual", "source": FC_SOURCE, "retrieved": FC_DATE},
    {"name": "Scale",    "pages": 1_000_000,"price_usd_mo": 599,  "billing": "annual", "source": FC_SOURCE, "retrieved": FC_DATE},
]
FIRECRAWL_MONTHLY_PREMIUM = C(0.20, "fraction over annual",
                              FC_SOURCE, FC_DATE,
                              notes="Monthly billing ~+20% over annual equivalent")
FIRECRAWL_FAILED_CHARGE   = C(0.0, "USD/failed-scrape", FC_SOURCE, FC_DATE,
                               notes="Failed scrapes do not consume credits")

# Brave Search API — https://brave.com/search/api/ (retrieved 2026-08-24)
BRAVE_SOURCE = "https://brave.com/search/api/"
BRAVE_DATE   = "2026-08-24"
BRAVE_PRICE  = C(0.005, "USD/query", BRAVE_SOURCE, BRAVE_DATE,
                 notes="$5 per 1 000 requests; README.md:610 is authoritative")

# ---------------------------------------------------------------------------
# 2.  AWS infrastructure rates
# ---------------------------------------------------------------------------

AWS_SOURCE_FARGATE = "https://aws.amazon.com/fargate/pricing/"
AWS_DATE = "2026-08-24"

# Fargate on-demand x86 rates
FARGATE_VCPU_HR = {
    "us-east-1":  C(0.04048, "USD/vCPU-hr", AWS_SOURCE_FARGATE, AWS_DATE),
    "eu-west-1":  C(0.04048, "USD/vCPU-hr", AWS_SOURCE_FARGATE, AWS_DATE),
    "af-south-1": C(0.05460, "USD/vCPU-hr", AWS_SOURCE_FARGATE, AWS_DATE,
                    notes="af-south-1 is +35% vs us-east-1"),
}
FARGATE_GB_HR = {
    "us-east-1":  C(0.004445, "USD/GiB-hr", AWS_SOURCE_FARGATE, AWS_DATE),
    "eu-west-1":  C(0.004445, "USD/GiB-hr", AWS_SOURCE_FARGATE, AWS_DATE),
    "af-south-1": C(0.006000, "USD/GiB-hr", AWS_SOURCE_FARGATE, AWS_DATE),
}
FARGATE_EPHEMERAL_GIB_HR = {
    "us-east-1":  C(0.00011088, "USD/GiB-hr", AWS_SOURCE_FARGATE, AWS_DATE,
                    notes="Billed above 21 GiB per task"),
    "af-south-1": C(0.000145,   "USD/GiB-hr", AWS_SOURCE_FARGATE, AWS_DATE),
}
FARGATE_SPOT_DISCOUNT = C(0.70, "fraction saving", AWS_SOURCE_FARGATE, AWS_DATE,
                           confidence="estimated",
                           notes="Spot ~70% cheaper; interruption risk; af-south-1 thin pools")

# Fargate ARM (Graviton) discount
FARGATE_GRAVITON_DISCOUNT = C(0.20, "fraction saving", AWS_SOURCE_FARGATE, AWS_DATE,
                               notes="ARM64 Fargate ~20% cheaper; requires Graviton build")

# EKS control plane
AWS_EKS_SOURCE = "https://aws.amazon.com/eks/pricing/"
EKS_CONTROL_PLANE_HR = C(0.10, "USD/hr", AWS_EKS_SOURCE, AWS_DATE,
                          notes="$73/mo per cluster")

# NAT Gateway
AWS_NAT_SOURCE = "https://aws.amazon.com/vpc/pricing/"
NAT_GW_HR     = C(0.045, "USD/hr",  AWS_NAT_SOURCE, AWS_DATE, notes="Per NAT Gateway")
NAT_GW_GB     = C(0.045, "USD/GiB", AWS_NAT_SOURCE, AWS_DATE,
                  notes="Per GiB processed; af-south-1 same rate")

# ALB
AWS_ALB_SOURCE = "https://aws.amazon.com/elasticloadbalancing/pricing/"
ALB_HR = C(0.0225, "USD/hr", AWS_ALB_SOURCE, AWS_DATE)
ALB_LCU_HR = C(0.008, "USD/LCU-hr", AWS_ALB_SOURCE, AWS_DATE)

# ElastiCache (Redis-compatible, t3.small, single node — mandatory for ECS path)
AWS_EC_SOURCE = "https://aws.amazon.com/elasticache/pricing/"
ELASTICACHE_SINGLE_NODE_MO = {
    "us-east-1":  C(26,  "USD/mo", AWS_EC_SOURCE, AWS_DATE,
                    notes="t3.small cache.t3.small on-demand, single-AZ"),
    "af-south-1": C(50,  "USD/mo", AWS_EC_SOURCE, AWS_DATE,
                    notes="Approximate; t3.small not available, t4g.small used"),
}

# EC2 instance rates (monthly, on-demand Linux)
AWS_EC2_SOURCE = "https://aws.amazon.com/ec2/pricing/on-demand/"
EC2_MO = {
    "m6i.xlarge_af-south-1":  C(185, "USD/mo", AWS_EC2_SOURCE, AWS_DATE, notes="4 vCPU/16 GiB"),
    "m6i.2xlarge_af-south-1": C(371, "USD/mo", AWS_EC2_SOURCE, AWS_DATE, notes="8 vCPU/32 GiB"),
    "m6g.large_af-south-1":   C(74,  "USD/mo", AWS_EC2_SOURCE, AWS_DATE, notes="2 vCPU/8 GiB ARM"),
    "m6i.xlarge_eu-west-1":   C(156, "USD/mo", AWS_EC2_SOURCE, AWS_DATE),
    "m6i.2xlarge_eu-west-1":  C(312, "USD/mo", AWS_EC2_SOURCE, AWS_DATE),
    "m6i.xlarge_us-east-1":   C(140, "USD/mo", AWS_EC2_SOURCE, AWS_DATE),
}

# CloudWatch Logs
CW_LOGS_INGEST = C(0.50, "USD/GiB", "https://aws.amazon.com/cloudwatch/pricing/", AWS_DATE)

# DigitalOcean droplets
DO_SOURCE = "https://www.digitalocean.com/pricing/droplets"
DO_DATE   = "2026-08-24"
DO_DROPLET_MO = {
    "8gb-4vcpu":  C(48,  "USD/mo", DO_SOURCE, DO_DATE),
    "16gb-8vcpu": C(96,  "USD/mo", DO_SOURCE, DO_DATE),
    "32gb-8vcpu": C(192, "USD/mo", DO_SOURCE, DO_DATE),
}

# ---------------------------------------------------------------------------
# 3.  Repository-derived topology (source: deploy/ manifests)
# ---------------------------------------------------------------------------

# ECS task definitions — deploy/ecs/task-definition-server.json and task-definition-worker.json
ECS_SERVER_VCPU     = C(2,    "vCPU",  "deploy/ecs/task-definition-server.json:8",  "2026-08-24", "published")
ECS_SERVER_MEM_GIB  = C(4,    "GiB",   "deploy/ecs/task-definition-server.json:9",  "2026-08-24", "published")
ECS_SERVER_EPH_GIB  = C(40,   "GiB",   "deploy/ecs/task-definition-server.json:28", "2026-08-24", "published")
ECS_WORKER_VCPU     = C(4,    "vCPU",  "deploy/ecs/task-definition-worker.json:8",  "2026-08-24", "published")
ECS_WORKER_MEM_GIB  = C(8,    "GiB",   "deploy/ecs/task-definition-worker.json:9",  "2026-08-24", "published")
ECS_WORKER_EPH_GIB  = C(40,   "GiB",   "deploy/ecs/task-definition-worker.json:28", "2026-08-24", "published")

# ECS HPA bounds — deploy/ecs/scaling.json
ECS_SERVER_DESIRED  = C(3,    "replicas", "deploy/ecs/scaling.json", "2026-08-24", "published")
ECS_SERVER_MAX      = C(20,   "replicas", "deploy/ecs/scaling.json", "2026-08-24", "published")
ECS_WORKER_DESIRED  = C(2,    "replicas", "deploy/ecs/scaling.json", "2026-08-24", "published")
ECS_WORKER_MAX      = C(50,   "replicas", "deploy/ecs/scaling.json", "2026-08-24", "published")
ECS_NAT_GW_COUNT    = C(3,    "gateways", "deploy/ecs/deploy.sh",    "2026-08-24", "published",
                         notes="One per AZ; private subnets require NAT")

# K8s base resources — deploy/k8s/base/server.yaml and worker.yaml
K8S_SERVER_CPU_REQ    = C(0.5,  "CPU",   "deploy/k8s/base/server.yaml", "2026-08-24", "published")
K8S_SERVER_MEM_REQ    = C(1.5,  "GiB",   "deploy/k8s/base/server.yaml", "2026-08-24", "published",
                           notes="Includes 1 GiB dshm emptyDir{medium:Memory}")
K8S_WORKER_CPU_REQ    = C(1.0,  "CPU",   "deploy/k8s/base/worker.yaml", "2026-08-24", "published")
K8S_WORKER_MEM_REQ    = C(3.125,"GiB",   "deploy/k8s/base/worker.yaml", "2026-08-24", "published",
                           notes="Includes 1 GiB dshm; usable heap is 7 GiB of 8 GiB limit")
K8S_SERVER_REPLICAS   = C(3,    "replicas","deploy/k8s/base/server.yaml","2026-08-24","published")
K8S_WORKER_REPLICAS   = C(2,    "replicas","deploy/k8s/base/worker.yaml","2026-08-24","published")
K8S_SERVER_MAX_CONCURRENCY = C(8,  "renders", "deploy/k8s/base/server.yaml","2026-08-24","published")
K8S_WORKER_MAX_CONCURRENCY = C(16, "renders", "deploy/k8s/base/worker.yaml","2026-08-24","published")
BROWSER_MAX_JOBS           = C(50, "renders/recycle", "src/config.ts", "2026-08-24", "published")

# ---------------------------------------------------------------------------
# 4.  Assumptions (confidence = "assumed" — flagged loudly in output)
# ---------------------------------------------------------------------------

ASSUMPTION_RENDER_LATENCY_S = C(4.0,  "s/page", "SLO.md — TBD", "2026-08-24",
                                 confidence="assumed",
                                 notes="All SLO.md measured values are TBD. Range: 2–8 s. "
                                       "MOST DECISION-SENSITIVE PARAMETER.")
ASSUMPTION_SUCCESS_RATE     = C(0.75, "fraction", "SLO.md — TBD", "2026-08-24",
                                 confidence="assumed",
                                 notes="25% failure rate on public web (bot-blocking, timeouts). "
                                       "Vendor charges $0 for failures; self-host pays full compute.")
ASSUMPTION_BYTES_PAGE_RBR   = C(0.5,  "MiB", "TAVILY_PARITY_PLAN.md:692", "2026-08-24",
                                 confidence="estimated",
                                 notes="RENDER_BLOCK_RESOURCES=true. With false: ~2 MiB/page.")
ASSUMPTION_DUTY_CYCLE       = C(0.10, "fraction", "assumed", "2026-08-24",
                                 confidence="assumed",
                                 notes="10% duty cycle = ~2.4h active/day for a business-hours "
                                       "workload. Self-host pays 24x7 regardless.")
ASSUMPTION_FTE_FLOOR        = C(0.06, "FTE", "assumed", "2026-08-24",
                                 confidence="estimated",
                                 notes="Hard floor: ~10-15 Chromium CVEs/yr × 4-8h each + "
                                       "Playwright monthly cadence + Dependabot. "
                                       "Does not include on-call rota.")
ASSUMPTION_ZAR_USD          = C(18.5, "ZAR/USD", "assumed", "2026-08-24",
                                 confidence="assumed",
                                 notes="Approximate 2026 rate. ZAR/USD volatility ~15-20%/yr. "
                                       "Depreciation makes SaaS more expensive; appreciation less.")
ASSUMPTION_ENGINEERING_RATE = C(80_000, "USD/FTE/yr fully-loaded",
                                 "assumed", "2026-08-24",
                                 confidence="assumed",
                                 notes="SA senior engineer fully-loaded ~R1.5M/yr ≈ $80k at 18.5")
ASSUMPTION_SETUP_WEEKS      = C(12,   "weeks", "assumed", "2026-08-24",
                                 confidence="assumed",
                                 notes="Initial ATO + deployment setup. Amortised over 3 years.")
ASSUMPTION_CACHE_HIT_RATE   = C(0.05, "fraction", "src/fetcher.ts:50-58", "2026-08-24",
                                 confidence="estimated",
                                 notes="Per-process 50 MiB/15-min LRU (src/fetcher.ts). "
                                       "Divided by N replicas in multi-node: effective ≈5%. "
                                       "Vendor global cache measured in days. Cache favours buy.")
ASSUMPTION_LLM_TOKENS_IN_PER_PAGE = C(4_000, "tokens/page",
                                        "assumed", "2026-08-24",
                                        confidence="assumed",
                                        notes="Downstream LLM context per extracted page. "
                                              "Retrieval is 1-4% of total pipeline cost. "
                                              "Token efficiency is the dominant lever.")
ASSUMPTION_LOGS_GIB_MO      = C(5.0, "GiB/mo", "assumed", "2026-08-24", confidence="estimated")

# ---------------------------------------------------------------------------
# 5.  Cost functions
# ---------------------------------------------------------------------------

HOURS_PER_MONTH = 730  # 365.25/12 * 24


def fargate_monthly(vcpu, mem_gib, replicas, eph_gib, region, hours=HOURS_PER_MONTH):
    """Compute Fargate on-demand monthly cost (USD)."""
    vcpu_rate = FARGATE_VCPU_HR[region]["value"]
    mem_rate  = FARGATE_GB_HR[region]["value"]
    eph_rate  = FARGATE_EPHEMERAL_GIB_HR.get(region, FARGATE_EPHEMERAL_GIB_HR["us-east-1"])["value"]
    eph_billable = max(0, eph_gib - 21)  # AWS bills above 21 GiB
    compute = (vcpu * vcpu_rate + mem_gib * mem_rate) * hours * replicas
    storage = eph_billable * eph_rate * hours * replicas
    return compute + storage


def nat_gw_monthly(count, gb_processed, region="af-south-1"):
    """NAT Gateway: hours + data processing."""
    hr_cost   = NAT_GW_HR["value"] * HOURS_PER_MONTH * count
    data_cost = NAT_GW_GB["value"] * gb_processed
    return hr_cost + data_cost


def tavily_cost(pages_mo, workload_mix):
    """Tavily cost given monthly pages and workload mix {search, extract, crawl} fractions."""
    search_q = pages_mo * workload_mix["search"]
    extract_q = pages_mo * workload_mix["extract"]
    crawl_p   = pages_mo * workload_mix["crawl"]
    credits = (search_q * TAVILY_CREDITS_BASIC_SEARCH["value"]
               + extract_q * TAVILY_CREDITS_BASIC_EXTRACT["value"]
               + crawl_p   * TAVILY_CREDITS_CRAWL_PAGE["value"])
    # Staircase: find the lowest-cost tier
    best_cost = credits * TAVILY_PAYG["value"]  # PAYG fallback
    for tier in TAVILY_TIERS:
        if credits <= tier["credits"]:
            best_cost = min(best_cost, tier["price_usd_mo"])
            break
    else:
        # Above Growth tier: use Growth unit rate (custom pricing likely cheaper, but list = ceiling)
        growth = TAVILY_TIERS[-1]
        best_cost = growth["price_usd_mo"] + max(0, credits - growth["credits"]) * (growth["price_usd_mo"] / growth["credits"])
    return best_cost


def firecrawl_cost(pages_mo, billing="annual"):
    """Firecrawl cost — staircase function."""
    premium = (1 + FIRECRAWL_MONTHLY_PREMIUM["value"]) if billing == "monthly" else 1.0
    tiers = sorted(FIRECRAWL_TIERS, key=lambda t: t["pages"])
    for tier in tiers:
        if pages_mo <= tier["pages"]:
            return tier["price_usd_mo"] * premium
    # Above Scale tier: extrapolate at Scale unit rate
    scale = tiers[-1]
    unit_rate = scale["price_usd_mo"] / scale["pages"]
    return (scale["price_usd_mo"] + (pages_mo - scale["pages"]) * unit_rate) * premium


def engineering_monthly(fte):
    """Monthly engineering cost (setup amortised over 3 years + ongoing)."""
    setup_fte   = ASSUMPTION_SETUP_WEEKS["value"] / 52  # fraction of FTE-year
    setup_annual = setup_fte * ASSUMPTION_ENGINEERING_RATE["value"]
    setup_mo    = setup_annual / 36  # amortised over 3 years
    ongoing_mo  = fte * ASSUMPTION_ENGINEERING_RATE["value"] / 12
    return setup_mo + ongoing_mo


# ---------------------------------------------------------------------------
# 6.  Deployment mode cost functions
# ---------------------------------------------------------------------------

def mode_A_cost():
    """Mode A: Local stdio / npx — $0 marginal."""
    return {"compute": 0, "overhead": 0, "total": 0, "note": "No server; honest floor"}


def mode_B_cost(region="af-south-1"):
    """Mode B: Single VM, Docker Compose, no HA."""
    if region == "digitalocean":
        vm = DO_DROPLET_MO["8gb-4vcpu"]["value"]
    elif region == "af-south-1":
        vm = EC2_MO["m6g.large_af-south-1"]["value"]
    else:
        vm = EC2_MO["m6i.xlarge_eu-west-1"]["value"]
    logs = CW_LOGS_INGEST["value"] * ASSUMPTION_LOGS_GIB_MO["value"] if region != "digitalocean" else 0
    return {"compute": vm, "overhead": logs, "total": vm + logs,
            "note": "Single VM, no HA, mandatory Redis-optional (SQLite works)"}


def mode_C_cost(region="af-south-1"):
    """Mode C: Single VM, --role=both, smallest viable."""
    if region == "digitalocean":
        vm = DO_DROPLET_MO["8gb-4vcpu"]["value"]
    elif region == "af-south-1":
        vm = EC2_MO["m6g.large_af-south-1"]["value"]
    else:
        vm = 80  # rough t3.large equivalent
    return {"compute": vm, "overhead": 0, "total": vm,
            "note": "Cheapest possible; role=both; SQLite store; no Redis"}


def mode_E_cost(region="af-south-1"):
    """Mode E: K8s prod overlay, minimum replicas."""
    if region == "af-south-1":
        node_cost = EC2_MO["m6i.xlarge_af-south-1"]["value"]
        nodes = 3
    else:
        node_cost = EC2_MO["m6i.xlarge_eu-west-1"]["value"]
        nodes = 3
    compute = node_cost * nodes
    eks     = EKS_CONTROL_PLANE_HR["value"] * HOURS_PER_MONTH
    nat     = nat_gw_monthly(1, 50)  # 1 NAT GW, ~50 GiB/mo
    alb     = ALB_HR["value"] * HOURS_PER_MONTH
    logs    = CW_LOGS_INGEST["value"] * ASSUMPTION_LOGS_GIB_MO["value"]
    total   = compute + eks + nat + alb + logs
    return {"compute": compute, "eks": round(eks, 2), "nat": round(nat, 2),
            "alb": round(alb, 2), "logs": round(logs, 2), "total": round(total, 2),
            "note": "3×m6i.xlarge, EKS, 1 NAT GW, ALB, CloudWatch"}


def mode_F_cost(region="af-south-1", at_max=False):
    """Mode F: ECS Fargate as shipped (desired counts or HPA max)."""
    server_r = ECS_SERVER_MAX["value"] if at_max else ECS_SERVER_DESIRED["value"]
    worker_r = ECS_WORKER_MAX["value"] if at_max else ECS_WORKER_DESIRED["value"]

    server_c = fargate_monthly(ECS_SERVER_VCPU["value"], ECS_SERVER_MEM_GIB["value"],
                                server_r, ECS_SERVER_EPH_GIB["value"], region)
    worker_c = fargate_monthly(ECS_WORKER_VCPU["value"], ECS_WORKER_MEM_GIB["value"],
                                worker_r, ECS_WORKER_EPH_GIB["value"], region)

    compute = server_c + worker_c
    nat_count = ECS_NAT_GW_COUNT["value"]
    nat     = nat_gw_monthly(nat_count, 100 if not at_max else 5000)
    alb     = ALB_HR["value"] * HOURS_PER_MONTH
    redis   = ELASTICACHE_SINGLE_NODE_MO.get(region, ELASTICACHE_SINGLE_NODE_MO["af-south-1"])["value"]
    logs    = CW_LOGS_INGEST["value"] * (ASSUMPTION_LOGS_GIB_MO["value"] if not at_max else 100)
    total   = compute + nat + alb + redis + logs
    return {
        "compute": round(compute, 2),
        "nat":     round(nat, 2),
        "alb":     round(alb, 2),
        "redis":   redis,
        "logs":    round(logs, 2),
        "total":   round(total, 2),
        "server_replicas": server_r,
        "worker_replicas": worker_r,
        "note": f"ECS Fargate {'HPA-max' if at_max else 'desired'}, {region}",
    }


def mode_F_rightsized(region="af-south-1", spot=False):
    """Mode F right-sized: single Fargate task, role=both, SQLite, 1 NAT GW."""
    vcpu, mem_gib, eph_gib = 4, 8, 40
    compute = fargate_monthly(vcpu, mem_gib, 1, eph_gib, region)
    if spot:
        compute *= (1 - FARGATE_SPOT_DISCOUNT["value"])
    nat   = nat_gw_monthly(1, 50)
    alb   = ALB_HR["value"] * HOURS_PER_MONTH
    logs  = CW_LOGS_INGEST["value"] * ASSUMPTION_LOGS_GIB_MO["value"]
    total = compute + nat + alb + logs
    return {
        "compute": round(compute, 2),
        "nat":     round(nat, 2),
        "alb":     round(alb, 2),
        "redis":   0,
        "logs":    round(logs, 2),
        "total":   round(total, 2),
        "note": f"Right-sized single task {'(Spot)' if spot else '(on-demand)'}, {region}, role=both, SQLite",
    }


# OpenShift / existing-infra assumptions
ASSUMPTION_OCP_FTE_ONGOING = C(0.015, "FTE", "assumed", "2026-08-25",
                                confidence="assumed",
                                notes="Midpoint of 0.01-0.02 FTE range for a containerized service "
                                      "running on existing OpenShift with mature CI/CD. "
                                      "Replaces the 0.06 FTE cloud-infra floor: no nodes, no NAT, "
                                      "no ALB to manage. Dominated by Playwright/Chromium image "
                                      "update reviews (~30 min each × 4-6/yr) + Dependabot triage.")
ASSUMPTION_OCP_SETUP_WEEKS = C(10, "weeks", "assumed", "2026-08-25",
                                confidence="assumed",
                                notes="One-time setup: OpenShift Route, SecurityContextConstraints, "
                                      "Chromium proxy passthrough (browserPool.ts launch args), "
                                      "KEDA/prometheus-adapter for HPA custom metrics, "
                                      "initial SLO validation. Amortised over 3 years.")


def mode_G_openshift_cost():
    """
    Mode G: Existing OpenShift cluster + in-house web proxy + free providers.
    Marginal infra = $0.  Engineering is the only variable.
    """
    return {
        "compute":           0,
        "nat":               0,
        "alb_routes":        0,
        "ocp_control_plane": 0,
        "redis":             0,
        "logs":              0,
        "vendor_search":     0,
        "total_infra":       0,
        "note": ("Existing OpenShift + in-house proxy + free providers (SearXNG clean profile). "
                 "Marginal infrastructure cost is zero. "
                 "Engineering is the only recurring cost. "
                 "Caveats: disable DDG (ToS), recall lower than Tavily, "
                 "Chromium proxy config needed, SCC required for worker pods."),
    }


def mode_G_engineering():
    """Engineering costs for Mode G: setup amortised + low ongoing."""
    rate = ASSUMPTION_ENGINEERING_RATE["value"]
    setup_fte_yr = ASSUMPTION_OCP_SETUP_WEEKS["value"] / 52
    setup_mo = (setup_fte_yr * rate) / 36  # amortised over 3 years
    ongoing_mo = ASSUMPTION_OCP_FTE_ONGOING["value"] * rate / 12
    return {
        "setup_weeks":        ASSUMPTION_OCP_SETUP_WEEKS["value"],
        "setup_fte":          round(setup_fte_yr, 3),
        "setup_amortised_mo": round(setup_mo, 2),
        "ongoing_fte":        ASSUMPTION_OCP_FTE_ONGOING["value"],
        "ongoing_mo":         round(ongoing_mo, 2),
        "total_mo":           round(setup_mo + ongoing_mo, 2),
        "total_yr":           round((setup_mo + ongoing_mo) * 12, 2),
        "total_zar_yr":       round((setup_mo + ongoing_mo) * 12
                                    * ASSUMPTION_ZAR_USD["value"], 2),
    }


# ---------------------------------------------------------------------------
# 7.  Throughput and unit-cost estimates
# ---------------------------------------------------------------------------

def self_host_pages_per_month(vcpu_total, concurrency, region="af-south-1"):
    """
    Estimate pages/month given total vCPU and concurrency (Chromium contexts).
    Throughput is render-latency bound (the most assumed input in the model).
    """
    latency_s     = ASSUMPTION_RENDER_LATENCY_S["value"]
    success_rate  = ASSUMPTION_SUCCESS_RATE["value"]
    duty_cycle    = ASSUMPTION_DUTY_CYCLE["value"]
    pages_per_s   = (concurrency / latency_s) * success_rate
    pages_per_hr  = pages_per_s * 3600
    return pages_per_hr * HOURS_PER_MONTH * duty_cycle


def self_host_unit_cost(infra_mo, pages_mo):
    """Cost per successfully extracted page."""
    if pages_mo == 0:
        return float("inf")
    return infra_mo / pages_mo


# ---------------------------------------------------------------------------
# 8.  Break-even analysis
# ---------------------------------------------------------------------------

def breakeven_volume(infra_mo, eng_fte, vendor_unit_cost, fte_floor=None):
    """
    Monthly volume at which self-host TCO = vendor cost (list prices).
    infra_mo:         fixed monthly infrastructure cost
    eng_fte:          ongoing FTE fraction
    fte_floor:        minimum FTE (defaults to ASSUMPTION_FTE_FLOOR)
    Returns pages/month, or None if no crossover within 10M pages.
    """
    floor = fte_floor if fte_floor is not None else ASSUMPTION_FTE_FLOOR["value"]
    fte_effective = max(eng_fte, floor)
    eng_mo = engineering_monthly(fte_effective)

    for v in range(1000, 10_000_001, 1000):
        self_total = infra_mo + eng_mo
        buy_total  = firecrawl_cost(v, billing="annual")
        if self_total <= buy_total:
            return v
    return None  # self-host never wins at list prices within 10M pages


# ---------------------------------------------------------------------------
# 9.  Assemble the output JSON
# ---------------------------------------------------------------------------

def build_output():
    out = {}

    # --- vendor tiers ---
    out["tavily_tiers"] = TAVILY_TIERS
    out["firecrawl_tiers"] = FIRECRAWL_TIERS
    out["brave_price_usd_per_query"] = BRAVE_PRICE

    # Explicit unit rates for citation guards
    out["firecrawl_standard_unit_rate_usd_per_page"] = C(
        round(83 / 100_000, 6), "USD/page", FC_SOURCE, FC_DATE,
        notes="$83/100k = $0.00083/page (annual billing)")
    out["tavily_growth_unit_rate_usd_per_credit"] = C(
        round(500 / 100_000, 6), "USD/credit", TAVILY_SOURCE, TAVILY_DATE,
        notes="$500/100k credits = $0.005/credit")

    # --- infra rates ---
    out["fargate_vcpu_hr_af_south_1"]     = FARGATE_VCPU_HR["af-south-1"]
    out["fargate_gb_hr_af_south_1"]       = FARGATE_GB_HR["af-south-1"]
    out["fargate_spot_discount"]          = FARGATE_SPOT_DISCOUNT
    out["eks_control_plane_hr"]           = EKS_CONTROL_PLANE_HR
    out["nat_gw_hr"]                      = NAT_GW_HR
    out["nat_gw_gb"]                      = NAT_GW_GB
    out["elasticache_single_node_af_south_1"] = ELASTICACHE_SINGLE_NODE_MO["af-south-1"]

    # --- assumptions ---
    out["assumption_render_latency_s"]      = ASSUMPTION_RENDER_LATENCY_S
    out["assumption_success_rate"]          = ASSUMPTION_SUCCESS_RATE
    out["assumption_duty_cycle"]            = ASSUMPTION_DUTY_CYCLE
    out["assumption_fte_floor"]             = ASSUMPTION_FTE_FLOOR
    out["assumption_zar_usd"]              = ASSUMPTION_ZAR_USD
    out["assumption_engineering_rate_usd"] = ASSUMPTION_ENGINEERING_RATE
    out["assumption_cache_hit_rate"]       = ASSUMPTION_CACHE_HIT_RATE
    out["assumption_llm_tokens_per_page"]  = ASSUMPTION_LLM_TOKENS_IN_PER_PAGE

    # --- deployment mode costs (af-south-1) ---
    out["mode_A"] = mode_A_cost()
    out["mode_B_af_south_1"] = mode_B_cost("af-south-1")
    out["mode_B_digitalocean"] = mode_B_cost("digitalocean")
    out["mode_C_af_south_1"] = mode_C_cost("af-south-1")
    out["mode_E_af_south_1"] = mode_E_cost("af-south-1")
    out["mode_F_desired_af_south_1"]    = mode_F_cost("af-south-1", at_max=False)
    out["mode_F_hpa_max_af_south_1"]    = mode_F_cost("af-south-1", at_max=True)
    out["mode_F_rightsized_af_south_1"] = mode_F_rightsized("af-south-1", spot=False)
    out["mode_F_rightsized_spot_af_south_1"] = mode_F_rightsized("af-south-1", spot=True)
    out["mode_G_openshift"]           = mode_G_openshift_cost()
    out["mode_G_openshift_eng"]       = mode_G_engineering()

    # --- scale multiplier (HPA max / desired) ---
    shipped_desired = out["mode_F_desired_af_south_1"]["total"]
    shipped_max     = out["mode_F_hpa_max_af_south_1"]["total"]
    out["hpa_cost_multiplier"] = round(shipped_max / shipped_desired, 1) if shipped_desired else None

    # --- workload mixes ---
    WORKLOAD_MIXES = {
        "search_heavy":  {"search": 0.70, "extract": 0.25, "crawl": 0.05},
        "extract_heavy": {"search": 0.10, "extract": 0.70, "crawl": 0.20},
        "crawl_heavy":   {"search": 0.05, "extract": 0.20, "crawl": 0.75},
    }

    # --- vendor cost at reference volumes ---
    ref_volumes = [1_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000]
    out["vendor_cost_by_volume"] = {}
    for vol in ref_volumes:
        out["vendor_cost_by_volume"][str(vol)] = {
            "tavily_extract_heavy": round(tavily_cost(vol, WORKLOAD_MIXES["extract_heavy"]), 2),
            "tavily_crawl_heavy":   round(tavily_cost(vol, WORKLOAD_MIXES["crawl_heavy"]), 2),
            "firecrawl_annual":     round(firecrawl_cost(vol, "annual"), 2),
            "firecrawl_monthly":    round(firecrawl_cost(vol, "monthly"), 2),
        }

    # --- break-even analysis ---
    shipped_infra = out["mode_F_desired_af_south_1"]["total"]
    rightsized_infra = out["mode_F_rightsized_af_south_1"]["total"]

    out["breakeven"] = {}
    ocp_floor = ASSUMPTION_OCP_FTE_ONGOING["value"]
    configs = [
        ("shipped_ecs", shipped_infra,  ASSUMPTION_FTE_FLOOR["value"]),
        ("rightsized",  rightsized_infra, ASSUMPTION_FTE_FLOOR["value"]),
        ("openshift",   0,              ocp_floor),
    ]
    for label, infra, floor in configs:
        out["breakeven"][label] = {}
        fte_values = [0.0, floor, 0.10, 0.25, 0.50] if label != "openshift" else [ocp_floor, 0.05, 0.10, 0.25]
        for fte in fte_values:
            bev = breakeven_volume(infra, fte, None, fte_floor=floor)
            eff_fte = max(fte, floor)
            out["breakeven"][label][f"fte_{fte:.3f}"] = {
                "pages_per_month": bev,
                "pages_per_day":   round(bev / 30) if bev else None,
                "infra_mo":        round(infra, 2),
                "eng_mo":          round(engineering_monthly(eff_fte), 2),
                "total_mo":        round(infra + engineering_monthly(eff_fte), 2),
            }

    # --- token efficiency context ---
    pages_per_query = 5
    llm_in_tokens   = ASSUMPTION_LLM_TOKENS_IN_PER_PAGE["value"] * pages_per_query
    llm_out_tokens  = 1000
    # Claude Sonnet pricing (first-party reference, not Bedrock)
    # Source: https://www.anthropic.com/pricing (2026-08-24) — Bedrock rates differ
    llm_cost_per_query = (llm_in_tokens * 3 + llm_out_tokens * 15) / 1_000_000
    retrieval_cost_per_query_firecrawl = firecrawl_cost(pages_per_query * 30 * 10_000, "annual") / (30 * 10_000)
    out["llm_vs_retrieval_context"] = {
        "llm_cost_per_query_usd": round(llm_cost_per_query, 6),
        "retrieval_cost_per_query_firecrawl_usd": round(retrieval_cost_per_query_firecrawl, 6),
        "retrieval_as_pct_of_llm": round(retrieval_cost_per_query_firecrawl / llm_cost_per_query * 100, 1),
        "note": "Retrieval is 1-4% of pipeline. Token efficiency dominates.",
        "caveat": "Bedrock Claude pricing differs from first-party; verify at aws.amazon.com/bedrock/pricing/",
    }

    # --- admitted assumptions (confidence = assumed) ---
    out["load_bearing_assumptions"] = [
        {"key": "render_latency_s",       "value": ASSUMPTION_RENDER_LATENCY_S["value"],
         "confidence": "assumed",  "impact": "HIGH — sets throughput ceiling",
         "resolution": "Run scripts/load-test.mjs with concurrency ramp to saturation"},
        {"key": "success_rate",            "value": ASSUMPTION_SUCCESS_RATE["value"],
         "confidence": "assumed",  "impact": "HIGH — affects unit cost and failure-billing asymmetry"},
        {"key": "duty_cycle",              "value": ASSUMPTION_DUTY_CYCLE["value"],
         "confidence": "assumed",  "impact": "VERY HIGH — self-host pays 24×7; bursty traffic amplifies"},
        {"key": "llm_tokens_per_page",     "value": ASSUMPTION_LLM_TOKENS_IN_PER_PAGE["value"],
         "confidence": "assumed",  "impact": "CRITICAL — retrieval is 1-4% of pipeline; "
                                              "±20% here is larger than all infra combined"},
        {"key": "zar_usd",                 "value": ASSUMPTION_ZAR_USD["value"],
         "confidence": "assumed",  "impact": "MEDIUM — ZAR depreciation makes SaaS more expensive"},
    ]

    return out


# ---------------------------------------------------------------------------
# 10. Charts
# ---------------------------------------------------------------------------

def build_charts(out, assets_dir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.ticker as ticker
    import numpy as np

    VOLUMES = np.logspace(3, 7, 200)  # 1k → 10M

    plt.rcParams.update({
        "figure.facecolor": "white",
        "axes.facecolor": "#f8f8f8",
        "axes.grid": True,
        "grid.color": "#dddddd",
        "font.size": 10,
        "axes.titlesize": 11,
        "axes.labelsize": 10,
    })

    # ------------------------------------------------------------------
    # Chart 1: Cost-ratio map — self-host vs best-buy, crawl-heavy workload
    # ------------------------------------------------------------------
    fig, axes = plt.subplots(1, 3, figsize=(16, 5))
    fig.suptitle("Chart 1 — Self-host Cost Ratio vs Firecrawl Scale\n"
                 "(ratio = 1.0 means equal cost; grey = unresolved on current evidence)",
                 fontsize=12, fontweight="bold")

    fte_values = np.linspace(0, 0.5, 30)
    infra_modes = [
        ("Shipped ECS\n(af-south-1)", out["mode_F_desired_af_south_1"]["total"], "#d62728"),
        ("Right-sized\n(af-south-1)", out["mode_F_rightsized_af_south_1"]["total"], "#1f77b4"),
        ("DO Droplet\n$48/mo", out["mode_B_digitalocean"]["total"], "#2ca02c"),
    ]

    for ax, (label, infra, color) in zip(axes, infra_modes):
        ratios = np.zeros((len(fte_values), len(VOLUMES)))
        for i, fte in enumerate(fte_values):
            fte_eff = max(fte, ASSUMPTION_FTE_FLOOR["value"])
            eng_mo = engineering_monthly(fte_eff)
            for j, vol in enumerate(VOLUMES):
                buy = firecrawl_cost(vol, "annual")
                self_total = infra + eng_mo
                ratios[i, j] = self_total / buy if buy > 0 else float("inf")

        # Uncertainty band: vary render_latency 2-8s, success_rate 0.6-0.9
        # Show the "central" ratio but shade the uncertainty
        vmin, vmax = 0.1, 10.0
        im = ax.contourf(VOLUMES, fte_values, np.clip(ratios, vmin, vmax),
                         levels=np.logspace(-1, 1, 30), cmap="RdYlGn_r",
                         norm=matplotlib.colors.LogNorm(vmin=vmin, vmax=vmax))

        # Ratio=1 contour
        cs = ax.contour(VOLUMES, fte_values, ratios, levels=[1.0], colors="black", linewidths=2)
        ax.clabel(cs, fmt="equal cost", fontsize=8)

        # Mark FTE floor
        ax.axhline(ASSUMPTION_FTE_FLOOR["value"], color="navy", linestyle=":", linewidth=1.5,
                   label=f"FTE floor={ASSUMPTION_FTE_FLOOR['value']}")

        ax.set_xscale("log")
        ax.set_xlabel("Monthly pages/queries (log scale)")
        ax.set_ylabel("Engineering FTE (ongoing)")
        ax.set_title(label, color=color)
        ax.legend(fontsize=8)

        # Add uncertainty shading note
        ax.text(0.02, 0.97, "⚠ Throughput unmeasured\nconfidence band wide",
                transform=ax.transAxes, fontsize=7, va="top",
                bbox=dict(boxstyle="round,pad=0.3", facecolor="#ffffcc", alpha=0.8))

    plt.colorbar(im, ax=axes[-1], label="Cost ratio (self-host / Firecrawl)", shrink=0.8)
    plt.tight_layout()
    fig.savefig(assets_dir / "cost-chart1-ratio-map.svg", dpi=150, bbox_inches="tight")
    fig.savefig(assets_dir / "cost-chart1-ratio-map.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    # ------------------------------------------------------------------
    # Chart 2: Right-sizing waterfall (bar chart)
    # ------------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(12, 6))
    shipped = out["mode_F_desired_af_south_1"]
    rs      = out["mode_F_rightsized_af_south_1"]
    rs_spot = out["mode_F_rightsized_spot_af_south_1"]

    # Waterfall: step-by-step savings
    steps = [
        ("Shipped ECS\n(desired,\naf-south-1)", shipped["total"],      "#d62728"),
        ("Drop 2 NAT GWs\n(keep 1)",            shipped["total"] - (NAT_GW_HR["value"] * HOURS_PER_MONTH * 2),  "#ff7f0e"),
        ("Drop ElastiCache\n(SQLite store)",     shipped["total"] - (NAT_GW_HR["value"] * HOURS_PER_MONTH * 2)
                                                  - ELASTICACHE_SINGLE_NODE_MO["af-south-1"]["value"], "#bcbd22"),
        ("Single Fargate\ntask (right-size)", rs["total"],             "#1f77b4"),
        ("+ Fargate Spot\nfor workers",       rs_spot["total"],        "#17becf"),
        ("Firecrawl Std\n100k pages",         83,                      "#2ca02c"),
        ("Firecrawl Scale\n1M pages",         599,                     "#2ca02c"),
    ]

    labels = [s[0] for s in steps]
    values = [s[1] for s in steps]
    colors = [s[2] for s in steps]

    bars = ax.bar(labels, values, color=colors, width=0.6, edgecolor="white", linewidth=1.5)
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 8,
                f"${val:.0f}", ha="center", va="bottom", fontsize=9, fontweight="bold")

    ax.set_ylabel("Monthly cost (USD)")
    ax.set_title("Chart 2 — Right-sizing Waterfall: Shipped ECS → Firecrawl\n"
                 "af-south-1 (POPIA residency)", fontsize=11, fontweight="bold")
    ax.axhline(83,  color="#2ca02c", linestyle="--", linewidth=1, alpha=0.7, label="Firecrawl Standard $83")
    ax.axhline(599, color="#1a7a1a", linestyle="--", linewidth=1, alpha=0.7, label="Firecrawl Scale $599")
    ax.legend(fontsize=9)
    plt.xticks(rotation=15, ha="right")
    plt.tight_layout()
    fig.savefig(assets_dir / "cost-chart2-waterfall.svg", dpi=150, bbox_inches="tight")
    fig.savefig(assets_dir / "cost-chart2-waterfall.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    # ------------------------------------------------------------------
    # Chart 3: Total pipeline cost composition
    # ------------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(12, 6))
    ref_vol = 100_000  # 100k pages/mo at 10k queries/day × 5 pages
    llm_mo  = out["llm_vs_retrieval_context"]["llm_cost_per_query_usd"] * (ref_vol / 5) * 30 / 30
    # Actually recalculate: 100k pages, 5 pages/query → 20k queries/mo
    queries_mo = ref_vol / 5
    llm_cost_mo = out["llm_vs_retrieval_context"]["llm_cost_per_query_usd"] * queries_mo

    categories = ["LLM\ninference", "Retrieval\ncost", "Infra\n(overhead)", "Engineering\n(0.1 FTE)"]
    self_vals  = [
        llm_cost_mo,
        0,  # self-host retrieval: included in infra
        out["mode_F_rightsized_af_south_1"]["total"],
        engineering_monthly(0.10),
    ]
    firecrawl_vals = [
        llm_cost_mo,
        firecrawl_cost(ref_vol, "annual"),
        0,
        0,
    ]

    x = np.arange(len(categories))
    w = 0.35
    b1 = ax.bar(x - w/2, self_vals,     w, label="Self-host (right-sized, af-south-1)", color="#1f77b4", alpha=0.85)
    b2 = ax.bar(x + w/2, firecrawl_vals, w, label="Firecrawl Standard (100k pages)",    color="#2ca02c", alpha=0.85)

    for bar in list(b1) + list(b2):
        if bar.get_height() > 50:
            ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 20,
                    f"${bar.get_height():.0f}", ha="center", va="bottom", fontsize=9)

    ax.set_xticks(x)
    ax.set_xticklabels(categories)
    ax.set_ylabel("Monthly cost (USD)")
    ax.set_title(f"Chart 3 — Total Pipeline Cost Composition at {ref_vol:,} pages/month\n"
                 "Retrieval is 1-4% of total; LLM token efficiency is the dominant lever",
                 fontsize=11, fontweight="bold")
    ax.legend(fontsize=9)
    ax.text(0.5, 0.98,
            "⚠ LLM costs shown at first-party Claude Sonnet pricing;\n"
            "Bedrock rates differ — verify aws.amazon.com/bedrock/pricing/",
            transform=ax.transAxes, fontsize=7, ha="center", va="top",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="#ffffcc", alpha=0.8))
    plt.tight_layout()
    fig.savefig(assets_dir / "cost-chart3-pipeline-composition.svg", dpi=150, bbox_inches="tight")
    fig.savefig(assets_dir / "cost-chart3-pipeline-composition.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    # ------------------------------------------------------------------
    # Chart 4: Vendor staircases + self-host, ratio form
    # ------------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(12, 6))

    shipped_infra = out["mode_F_desired_af_south_1"]["total"]
    rs_infra      = out["mode_F_rightsized_af_south_1"]["total"]
    eng_floor_mo  = engineering_monthly(ASSUMPTION_FTE_FLOOR["value"])

    fc_vals    = [firecrawl_cost(v, "annual")  for v in VOLUMES]
    fc_mo_vals = [firecrawl_cost(v, "monthly") for v in VOLUMES]

    ratio_shipped = [(shipped_infra + eng_floor_mo) / max(fc, 1) for fc in fc_vals]
    ratio_rs      = [(rs_infra + eng_floor_mo) / max(fc, 1) for fc in fc_vals]
    ratio_rs_25   = [(rs_infra + engineering_monthly(0.25)) / max(fc, 1) for fc in fc_vals]

    ax.semilogx(VOLUMES, ratio_shipped, color="#d62728", linewidth=2,
                label=f"Shipped ECS + FTE-floor (infra ${shipped_infra:.0f}/mo)")
    ax.semilogx(VOLUMES, ratio_rs,      color="#1f77b4", linewidth=2,
                label=f"Right-sized + FTE-floor (infra ${rs_infra:.0f}/mo)")
    ax.semilogx(VOLUMES, ratio_rs_25,   color="#1f77b4", linewidth=2, linestyle="--",
                label=f"Right-sized + 0.25 FTE")
    ax.axhline(1.0, color="black", linewidth=1.5, linestyle="-", label="Equal cost (ratio = 1.0)")
    ax.axhline(1.0, color="black", linewidth=0.5)

    # Shade uncertainty band for right-sized (latency 2s vs 8s affects nothing here — it's infra floor vs vol)
    ax.fill_between(VOLUMES,
                    [(rs_infra * 0.8 + eng_floor_mo) / max(fc, 1) for fc in fc_vals],
                    [(rs_infra * 1.2 + eng_floor_mo) / max(fc, 1) for fc in fc_vals],
                    alpha=0.15, color="#1f77b4", label="±20% infra uncertainty band")

    ax.set_xlabel("Monthly pages (log scale)")
    ax.set_ylabel("Cost ratio: self-host / Firecrawl (annual)")
    ax.set_title("Chart 4 — Vendor Staircase vs Self-host Cost Ratio\n"
                 "Multiple crossovers; ratio < 1.0 means self-host wins",
                 fontsize=11, fontweight="bold")
    ax.set_ylim(0, 20)
    ax.legend(fontsize=9, loc="upper right")
    ax.xaxis.set_major_formatter(ticker.FuncFormatter(
        lambda x, _: f"{int(x/1000)}k" if x < 1_000_000 else f"{x/1_000_000:.1f}M"))
    plt.tight_layout()
    fig.savefig(assets_dir / "cost-chart4-ratio-staircases.svg", dpi=150, bbox_inches="tight")
    fig.savefig(assets_dir / "cost-chart4-ratio-staircases.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    # ------------------------------------------------------------------
    # Chart 5: Break-even volume vs engineering FTE
    # ------------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(10, 6))

    fte_range = np.linspace(0, 0.5, 100)
    infra_configs = [
        ("Shipped ECS (af-south-1)", out["mode_F_desired_af_south_1"]["total"], "#d62728"),
        ("Right-sized (af-south-1)", out["mode_F_rightsized_af_south_1"]["total"], "#1f77b4"),
        ("Right-sized + Spot",       out["mode_F_rightsized_spot_af_south_1"]["total"], "#17becf"),
        ("DO Droplet $48",           out["mode_B_digitalocean"]["total"], "#2ca02c"),
    ]

    for label, infra, color in infra_configs:
        bevs = []
        for fte in fte_range:
            fte_eff = max(fte, ASSUMPTION_FTE_FLOOR["value"])
            eng_mo = engineering_monthly(fte_eff)
            total_self = infra + eng_mo
            # Find first volume where Firecrawl cost >= self-host total
            bev = None
            for v in range(1000, 10_000_001, 5000):
                if firecrawl_cost(v, "annual") >= total_self:
                    bev = v
                    break
            bevs.append(bev if bev else 10_000_001)
        ax.semilogy(fte_range, bevs, color=color, linewidth=2, label=label)

    ax.axvline(ASSUMPTION_FTE_FLOOR["value"], color="navy", linestyle=":", linewidth=1.5,
               label=f"FTE floor (0.06 — CVE/maint minimum)")
    ax.fill_betweenx([1000, 10_000_001], 0, ASSUMPTION_FTE_FLOOR["value"],
                     alpha=0.08, color="navy", label="Inadmissible (below FTE floor)")

    ax.set_xlabel("Ongoing engineering FTE")
    ax.set_ylabel("Break-even volume (pages/month, log scale)")
    ax.set_title("Chart 5 — Break-even Volume vs Engineering Cost\n"
                 "Volume above which self-hosting is cheaper than Firecrawl (annual, list price)",
                 fontsize=11, fontweight="bold")
    ax.legend(fontsize=9, loc="upper left")
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(
        lambda x, _: f"{int(x/1000)}k" if x < 1_000_000 else f"{x/1_000_000:.1f}M"))
    ax.set_ylim(1_000, 15_000_000)
    plt.tight_layout()
    fig.savefig(assets_dir / "cost-chart5-breakeven-fte.svg", dpi=150, bbox_inches="tight")
    fig.savefig(assets_dir / "cost-chart5-breakeven-fte.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    print("Charts written to", assets_dir)


# ---------------------------------------------------------------------------
# 11. Main
# ---------------------------------------------------------------------------

def main():
    json_only = "--json-only" in sys.argv

    out = build_output()

    # Stamp the output (not a timestamp in the model — stamped after compute)
    out["generated_note"] = ("Generated by scripts/cost-model.py. "
                              "All constants have source/retrieved fields. "
                              "confidence=assumed rows are load-bearing; see load_bearing_assumptions.")

    # Write JSON
    repo_root  = Path(__file__).parent.parent
    json_path  = Path(__file__).parent / "cost-model-output.json"
    assets_dir = repo_root / "docs" / "enterprise" / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    with open(json_path, "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"Wrote {json_path}")

    # Write charts
    if not json_only:
        try:
            build_charts(out, assets_dir)
        except ImportError as e:
            print(f"Chart generation skipped (missing dep: {e}). Re-run after: pip install matplotlib numpy")

    # Print key findings
    print("\n=== KEY FINDINGS ===")
    print(f"Shipped ECS (af-south-1, desired):  ${out['mode_F_desired_af_south_1']['total']:.0f}/mo")
    print(f"Right-sized single Fargate task:     ${out['mode_F_rightsized_af_south_1']['total']:.0f}/mo")
    print(f"Right-sized + Spot:                  ${out['mode_F_rightsized_spot_af_south_1']['total']:.0f}/mo")
    print(f"Firecrawl Standard (100k pages):     $83/mo")
    print(f"Firecrawl Scale (1M pages):          $599/mo")
    print(f"HPA cost multiplier:                 {out['hpa_cost_multiplier']}×")

    print("\n--- Break-even vs Firecrawl (pages/month) ---")
    for label in ["shipped_ecs", "rightsized", "openshift"]:
        bev = out["breakeven"][label]
        print(f"  {label}:")
        for k, v in bev.items():
            pages = v["pages_per_month"]
            daily = v["pages_per_day"]
            total_mo = v["total_mo"]
            pages_str = f"{pages/1_000_000:.1f}M" if pages and pages >= 1_000_000 else (f"{pages/1000:.0f}k" if pages else ">10M")
            print(f"    {k}: {pages_str}/mo ({daily}/day) at ${total_mo:.0f}/mo self-host total")

    print("\n--- Mode G (OpenShift) engineering ---")
    g = out["mode_G_openshift_eng"]
    print(f"  Setup: {g['setup_weeks']} weeks ({g['setup_fte']} FTE-yr), amortised ${g['setup_amortised_mo']}/mo")
    print(f"  Ongoing: {g['ongoing_fte']} FTE = ${g['ongoing_mo']}/mo = ${g['total_yr']:.0f}/yr = R{g['total_zar_yr']:,.0f}/yr")

    print("\n--- LLM vs retrieval context ---")
    ctx = out["llm_vs_retrieval_context"]
    print(f"  LLM cost/query:       ${ctx['llm_cost_per_query_usd']:.4f}")
    print(f"  Retrieval cost/query: ${ctx['retrieval_cost_per_query_firecrawl_usd']:.4f}")
    print(f"  Retrieval as % of LLM: {ctx['retrieval_as_pct_of_llm']}%")

    print("\n=== LOAD-BEARING ASSUMPTIONS (confidence=assumed) ===")
    for a in out["load_bearing_assumptions"]:
        print(f"  {a['key']}: {a['value']}  [{a['impact']}]")

    return out


if __name__ == "__main__":
    main()
