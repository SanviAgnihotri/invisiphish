| Change | From | To |
| --- | --- | --- |
| Add baseline table | none | Majority, TF-IDF+SVM, ComplementNB, DistilBERT, **full hybrid** |
| Task framing | "phishing detection" evaluated on spam | SMS Spam Collection as *baseline corpus*, plus a **phishing-specific** dataset as the main evaluation |
| Headline claim | 94.20% acc (loses to baseline) | **AUC + explainability + adaptivity**; accuracy reported honestly with baselines |
| Ablation | GenAI explanation adds +0.5 F1 | GenAI removed from the accuracy table; **explanation groundedness evaluated separately** (your `groundedness.ts` already computes this metric) |
| Statistics | single split | 5 seeds, mean ± std, 95% CI, significance tests |
| Missing artifact | FP-Growth with no itemsets shown | **Your `fpGrowth.ts` now produces them** — show real mined templates with support |
| Limitations → contributions | QR, polymorphism, feedback poisoning, multilingual | Implement QR + feedback poisoning defensively (Tier 2) |
| Add | — | **System evaluation**: latency, throughput, cost per analysis (the MSE-native section) |