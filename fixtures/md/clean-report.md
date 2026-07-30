# Quarterly Operations Report

This report summarises operational performance for the period. It exists to exercise the clean-document path: named styles, ordinary structure, nothing adversarial.

## Summary

Performance met expectations in three of four areas. The exception is described under **Findings** below.

## Findings

1. Throughput increased relative to the previous period.
2. Error rates remained within the agreed threshold.
3. Latency at the ninety-fifth percentile regressed.

### Detail

The latency regression correlates with the migration completed mid-period. It is tracked separately and is not considered a release blocker.

| Metric      | Previous | Current | Change |
| ----------- | -------- | ------- | ------ |
| Throughput  | 1,200    | 1,450   | +21%   |
| Error rate  | 0.4%     | 0.3%    | -0.1pp |
| p95 latency | 180ms    | 240ms   | +33%   |

## Recommendations

- Investigate the latency regression before the next migration window.
- Keep the current error budget unchanged.
- Re-measure after two weeks of steady state.
