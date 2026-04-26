---
project: samples
handle: diagram-d2-microservices
title: Microservices Architecture (D2)
type: diagram
subtype: diagram
tags: [example, architecture, d2, microservices]
---
```d2
direction: right

clients: Clients {
  web: Web App {
    shape: rectangle
    style.fill: "#dbeafe"
  }
  mobile: Mobile App {
    shape: rectangle
    style.fill: "#dbeafe"
  }
  cli: CLI Tool {
    shape: rectangle
    style.fill: "#dbeafe"
  }
}

gateway: API Gateway {
  shape: rectangle
  style.fill: "#fef3c7"
  style.stroke: "#f59e0b"

  auth: Auth Middleware
  rate: Rate Limiter
  route: Router
}

services: Services {
  style.fill: "#f0fdf4"

  users: User Service {
    shape: rectangle
    style.fill: "#dcfce7"
  }
  orders: Order Service {
    shape: rectangle
    style.fill: "#dcfce7"
  }
  payments: Payment Service {
    shape: rectangle
    style.fill: "#dcfce7"
  }
  notifications: Notification Service {
    shape: rectangle
    style.fill: "#dcfce7"
  }
}

data: Data Stores {
  style.fill: "#fdf2f8"

  pg: PostgreSQL {
    shape: cylinder
    style.fill: "#fce7f3"
  }
  redis: Redis {
    shape: cylinder
    style.fill: "#fce7f3"
  }
  s3: S3 Bucket {
    shape: cylinder
    style.fill: "#fce7f3"
  }
}

external: External {
  stripe: Stripe API {
    shape: rectangle
    style.fill: "#f3e8ff"
  }
  sendgrid: SendGrid {
    shape: rectangle
    style.fill: "#f3e8ff"
  }
}

clients.web -> gateway
clients.mobile -> gateway
clients.cli -> gateway

gateway -> services.users
gateway -> services.orders
gateway -> services.payments

services.users -> data.pg
services.orders -> data.pg
services.orders -> data.redis
services.payments -> external.stripe
services.notifications -> external.sendgrid

services.orders -> services.notifications: order events
services.payments -> services.notifications: payment events
services.users -> data.s3: avatars
```
