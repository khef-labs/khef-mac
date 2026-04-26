---
project: samples
handle: system-architecture
title: System Architecture Overview
type: context
tags: [architecture, infrastructure, example]
---
This document describes the high-level architecture of our platform.

## Overview

The system follows a microservices architecture with the following key components:

- **API Gateway**: Routes requests, handles auth, rate limiting
- **Core Services**: User, Order, Product, Inventory
- **Data Layer**: PostgreSQL (primary), Redis (cache), S3 (files)
- **Message Queue**: RabbitMQ for async processing

## Architecture Diagram

```mermaid
graph TB
    subgraph Clients
        Web[Web App]
        Mobile[Mobile App]
        Third[Third Party]
    end

    subgraph Edge
        CDN[CloudFront CDN]
        LB[Load Balancer]
    end

    subgraph Gateway
        API[API Gateway]
        Auth[Auth Service]
    end

    subgraph Services
        User[User Service]
        Order[Order Service]
        Product[Product Service]
        Inventory[Inventory Service]
        Notification[Notification Service]
    end

    subgraph Data
        PG[(PostgreSQL)]
        Redis[(Redis)]
        S3[(S3 Storage)]
    end

    subgraph Async
        RabbitMQ[RabbitMQ]
        Worker[Background Workers]
    end

    Web --> CDN
    Mobile --> CDN
    Third --> LB
    CDN --> LB
    LB --> API
    API --> Auth
    API --> User
    API --> Order
    API --> Product
    API --> Inventory

    User --> PG
    Order --> PG
    Product --> PG
    Inventory --> PG

    User --> Redis
    Product --> Redis

    Order --> RabbitMQ
    RabbitMQ --> Worker
    Worker --> Notification
    Notification --> S3
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| PostgreSQL | ACID compliance, complex queries, JSON support |
| Redis | Sub-ms latency for hot data, session storage |
| RabbitMQ | Reliable async processing, dead letter queues |
| Microservices | Independent scaling, team autonomy |

## Scaling Strategy

1. **Horizontal scaling**: Services are stateless, scale via replicas
2. **Database**: Read replicas for queries, connection pooling
3. **Caching**: Multi-tier (CDN → Redis → DB)
4. **Async**: Offload heavy work to background workers
