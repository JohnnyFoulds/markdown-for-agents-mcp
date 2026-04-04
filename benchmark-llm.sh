#!/bin/bash

# Benchmark Claude -p (prompt) requests

NUM_REQUESTS=5
TOTAL_TIME=0

echo "=== LLM Benchmark - Claude -p requests ==="
echo "Running $NUM_REQUESTS requests...\n"

for i in $(seq 1 $NUM_REQUESTS); do
    echo "Request $i:"
    START=$(date +%s%3N)

    OUTPUT=$(claude -p "Write exactly 50 words. Count carefully.")

    END=$(date +%s%3N)
    ELAPSED=$((END - START))

    WORD_COUNT=$(echo "$OUTPUT" | wc -w)
    CHAR_COUNT=$(echo "$OUTPUT" | wc -c)

    echo "  Time: ${ELAPSED}ms"
    echo "  Words: $WORD_COUNT"
    echo "  Chars: $CHAR_COUNT"
    echo "  Sample: ${OUTPUT:0:100}..."
    echo ""

    TOTAL_TIME=$((TOTAL_TIME + ELAPSED))
    # Small delay between requests
    sleep 1
done

AVG_TIME=$((TOTAL_TIME / NUM_REQUESTS))
echo "=== Results ==="
echo "Average time: ${AVG_TIME}ms"
echo "Total time: ${TOTAL_TIME}ms"
