---
project: samples
handle: diagram-d2-sequence-deployment
title: Deployment Sequence (D2)
type: diagram
subtype: diagram
tags: [example, sequence, deployment, d2]
---
```d2
shape: sequence_diagram

dev: Developer
gh: GitHub Actions
ecr: Container Registry
k8s: Kubernetes
slack: Slack

dev -> gh: git push main
gh -> gh: Run tests + lint
gh -> ecr: docker build & push
gh -> k8s: kubectl apply (canary 5%)
k8s -> gh: Health check OK
gh -> slack: "Canary deployed - monitoring"
gh -> gh: Wait 10 min
gh -> k8s: Check error rate
k8s -> gh: Error rate 0.02%
gh -> k8s: Full rollout (100%)
k8s -> gh: Rollout complete
gh -> slack: "v2.4.1 deployed to production"
gh -> dev: Deployment succeeded
```
