# AWS Marketplace Listing Documentation

## Skillsmith Enterprise Deployment Guide

This document provides comprehensive guidance for listing Skillsmith on AWS Marketplace, including seller registration, container product setup, pricing configuration, and metering integration.

---

## Table of Contents

1. [Seller Registration Requirements](#1-seller-registration-requirements)
2. [Container Product Listing](#2-container-product-listing)
3. [Pricing Configuration](#3-pricing-configuration)
4. [EULA Documentation](#4-eula-documentation)
5. [Usage Metering Integration](#5-usage-metering-integration)
6. [Launch Checklist](#6-launch-checklist)

---

## 1. Seller Registration Requirements

### 1.1 AWS Account Setup

#### Prerequisites

- Active AWS account with billing enabled
- AWS Organizations setup (recommended for enterprise sellers)
- IAM administrator access

#### Registration Steps

1. Navigate to [AWS Marketplace Management Portal](https://aws.amazon.com/marketplace/management/)
2. Click "Register as a Seller"
3. Complete the seller profile:
   - Legal business name
   - Business address
   - Primary contact information
   - Technical contact information

#### Required IAM Policies

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "aws-marketplace:*",
        "aws-marketplace-management:*",
        "ecr:*",
        "iam:CreateRole",
        "iam:AttachRolePolicy"
      ],
      "Resource": "*"
    }
  ]
}
```

### 1.2 Tax Documentation

#### Required Forms

| Document | Description | Deadline |
|----------|-------------|----------|
| W-9 (US Sellers) | Request for Taxpayer ID | Before first payout |
| W-8BEN (Non-US Individuals) | Certificate of Foreign Status | Before first payout |
| W-8BEN-E (Non-US Entities) | Certificate of Foreign Status for Entities | Before first payout |

#### Tax Interview Process

1. Access the AWS Marketplace Management Portal
2. Navigate to "Settings" > "Tax Information"
3. Complete the online tax interview
4. Upload required documentation
5. Wait for verification (typically 1-3 business days)

#### Tax Reporting

- AWS provides annual 1099-K forms for US sellers
- Non-US sellers receive appropriate tax documentation
- Revenue reports available monthly in seller portal

### 1.3 Banking Information

#### Disbursement Account Setup

1. Navigate to "Settings" > "Disbursement"
2. Provide banking details:
   - Bank name
   - Account holder name
   - Account number
   - Routing number (US) / SWIFT code (International)
   - Bank address

#### Supported Currencies

| Region | Currency | Notes |
|--------|----------|-------|
| United States | USD | Primary disbursement currency |
| European Union | EUR | Available for EU sellers |
| United Kingdom | GBP | Available for UK sellers |
| Australia | AUD | Available for AU sellers |

#### Payout Schedule

- Standard: Monthly disbursements
- Minimum threshold: $100 USD
- Processing time: 3-5 business days after month end

### 1.4 Product Listing Requirements

#### Product Information

| Field | Requirements | Example |
|-------|--------------|---------|
| Product Title | Max 72 characters | Skillsmith - AI Skills Development Platform |
| Short Description | Max 200 characters | Enterprise AI skills discovery and development |
| Full Description | Max 20,000 characters | Comprehensive product overview |
| Logo | 120x120 PNG, transparent background | skillsmith-logo.png |
| Highlights | 3-6 bullet points | Key features and benefits |

#### Required Assets

```
marketplace-assets/
├── logos/
│   ├── logo-120x120.png       # Required
│   ├── logo-250x250.png       # Optional, recommended
│   └── logo-square.svg        # Source file
├── screenshots/
│   ├── dashboard.png          # 1920x1080 minimum
│   ├── skills-view.png
│   └── analytics.png
├── videos/
│   └── product-demo.mp4       # Optional, max 5 minutes
└── documentation/
    ├── user-guide.pdf
    └── deployment-guide.pdf
```

---

## 2. Container Product Listing

### 2.1 ECR Repository Setup

#### Create Private ECR Repository

```bash
# Set variables
AWS_REGION="us-east-1"
REPO_NAME="skillsmith"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create ECR repository
aws ecr create-repository \
    --repository-name $REPO_NAME \
    --region $AWS_REGION \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256

# Get repository URI
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}"
echo "Repository URI: $ECR_URI"
```

#### Configure Repository Policy for Marketplace

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowMarketplacePull",
      "Effect": "Allow",
      "Principal": {
        "Service": "marketplace.amazonaws.com"
      },
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ]
    }
  ]
}
```

Apply the policy:

```bash
aws ecr set-repository-policy \
    --repository-name $REPO_NAME \
    --policy-text file://ecr-marketplace-policy.json
```

### 2.2 Container Image Requirements

#### Base Image Guidelines

- Use official base images (Amazon Linux 2, Ubuntu LTS)
- Avoid images with known vulnerabilities
- Keep image size optimized (recommended < 2GB)
- Support both AMD64 and ARM64 architectures

#### Dockerfile Best Practices

```dockerfile
# Skillsmith Production Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

FROM node:20-alpine AS production

# Security: Run as non-root user
RUN addgroup -g 1001 -S skillsmith && \
    adduser -S skillsmith -u 1001 -G skillsmith

WORKDIR /app

# Copy built application
COPY --from=builder --chown=skillsmith:skillsmith /app/dist ./dist
COPY --from=builder --chown=skillsmith:skillsmith /app/node_modules ./node_modules
COPY --from=builder --chown=skillsmith:skillsmith /app/package.json ./

# AWS Marketplace metering agent
COPY --chown=skillsmith:skillsmith scripts/metering-agent.sh /usr/local/bin/

USER skillsmith

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

EXPOSE 3000

ENV NODE_ENV=production

ENTRYPOINT ["/usr/local/bin/metering-agent.sh"]
CMD ["node", "dist/server.js"]
```

#### Security Requirements

| Requirement | Description | Validation |
|-------------|-------------|------------|
| No root user | Container must run as non-root | USER directive in Dockerfile |
| No hardcoded secrets | Use environment variables or secrets manager | Image scan |
| Vulnerability scan | No critical/high CVEs | ECR scan results |
| Signed images | Use Docker Content Trust | Notary signatures |

#### Image Scanning

```bash
# Enable automatic scanning
aws ecr put-image-scanning-configuration \
    --repository-name $REPO_NAME \
    --image-scanning-configuration scanOnPush=true

# Manual scan
aws ecr start-image-scan \
    --repository-name $REPO_NAME \
    --image-id imageTag=v1.0.0

# Check scan results
aws ecr describe-image-scan-findings \
    --repository-name $REPO_NAME \
    --image-id imageTag=v1.0.0
```

### 2.3 Version Tagging Strategy

#### Semantic Versioning

```
v{MAJOR}.{MINOR}.{PATCH}[-{PRERELEASE}][+{BUILD}]

Examples:
- v1.0.0          # Initial release
- v1.1.0          # Minor feature release
- v1.1.1          # Patch release
- v2.0.0-beta.1   # Pre-release
- v2.0.0-rc.1     # Release candidate
```

#### Required Tags

| Tag | Purpose | Update Frequency |
|-----|---------|------------------|
| `v{X.Y.Z}` | Immutable version tag | Per release |
| `latest` | Current stable release | Each stable release |
| `stable` | Production-ready | Each stable release |

#### Tagging Workflow

```bash
#!/bin/bash
# scripts/tag-and-push.sh

VERSION=$1
ECR_URI="123456789012.dkr.ecr.us-east-1.amazonaws.com/skillsmith"

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
    docker login --username AWS --password-stdin $ECR_URI

# Build multi-architecture image
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag $ECR_URI:$VERSION \
    --tag $ECR_URI:latest \
    --push \
    .

# Add marketplace-specific tags
docker tag $ECR_URI:$VERSION $ECR_URI:stable
docker push $ECR_URI:stable

echo "Published $VERSION to ECR"
```

---

## 3. Pricing Configuration

### 3.1 Pricing Models

AWS Marketplace supports multiple pricing models:

| Model | Description | Best For |
|-------|-------------|----------|
| Hourly | Pay per hour of usage | Variable workloads |
| Monthly | Fixed monthly subscription | Predictable usage |
| Annual | Annual subscription with discount | Long-term commitments |
| BYOL | Bring Your Own License | Existing customers |
| Usage-based | Pay per unit consumed | Metered services |

### 3.2 Skillsmith Pricing Mapping

#### Team Tier - $25/user/month

```yaml
tier: team
aws_monthly_price: 25.00
aws_annual_price: 270.00  # 10% discount
dimensions:
  - name: Users
    type: user_count
    unit: user-month
    price: 25.00
features:
  - ai_skill_discovery
  - basic_analytics
  - team_collaboration
  - email_support
limits:
  max_users: 50
  api_calls: 10000/month
  storage: 10GB
```

#### Enterprise Tier - $69/user/month

```yaml
tier: enterprise
aws_monthly_price: 69.00
aws_annual_price: 745.20  # 10% discount
dimensions:
  - name: Users
    type: user_count
    unit: user-month
    price: 69.00
features:
  - all_team_features
  - advanced_analytics
  - custom_integrations
  - sso_saml
  - dedicated_support
  - sla_guarantee
limits:
  max_users: unlimited
  api_calls: unlimited
  storage: 100GB
```

#### AWS Marketplace Pricing Configuration

```json
{
  "ProductId": "prod-skillsmith-enterprise",
  "Terms": [
    {
      "Type": "UsageBasedPricingTerm",
      "CurrencyCode": "USD",
      "RateCards": [
        {
          "Selector": {
            "Type": "Duration",
            "Value": "P1M"
          },
          "Constraints": {
            "QuantityConfiguration": {
              "Dimension": "team_users",
              "AllowedQuantities": [1, 10, 25, 50]
            }
          },
          "RateCard": [
            {
              "DimensionKey": "team_users",
              "Price": "25.00"
            }
          ]
        },
        {
          "Selector": {
            "Type": "Duration",
            "Value": "P1M"
          },
          "RateCard": [
            {
              "DimensionKey": "enterprise_users",
              "Price": "69.00"
            }
          ]
        }
      ]
    }
  ]
}
```

### 3.3 Free Tier/Trial Setup

#### 14-Day Free Trial Configuration

```json
{
  "FreeTrialDurationDays": 14,
  "FreeTrialType": "FreeTrial",
  "TrialConfiguration": {
    "maxUsers": 5,
    "features": ["all_team_features"],
    "limitations": {
      "apiCalls": 1000,
      "storage": "1GB"
    }
  },
  "ConversionPath": {
    "defaultTier": "team",
    "reminderEmails": [7, 3, 1],
    "gracePerdiodDays": 3
  }
}
```

#### Free Tier Implementation

```typescript
// src/billing/free-tier.ts

import { MarketplaceMeteringClient, RegisterUsageCommand } from "@aws-sdk/client-marketplace-metering";

interface FreeTierConfig {
  maxUsers: number;
  maxApiCalls: number;
  maxStorageGB: number;
  durationDays: number;
}

const FREE_TIER_CONFIG: FreeTierConfig = {
  maxUsers: 5,
  maxApiCalls: 1000,
  maxStorageGB: 1,
  durationDays: 14
};

export async function checkFreeTierEligibility(
  customerId: string,
  productCode: string
): Promise<boolean> {
  const client = new MarketplaceMeteringClient({ region: "us-east-1" });

  try {
    // Check if customer has active entitlement
    const command = new RegisterUsageCommand({
      ProductCode: productCode,
      PublicKeyVersion: 1
    });

    const response = await client.send(command);

    // Parse entitlement to check trial status
    const trialStart = new Date(response.Signature || Date.now());
    const trialEnd = new Date(trialStart);
    trialEnd.setDate(trialEnd.getDate() + FREE_TIER_CONFIG.durationDays);

    return new Date() < trialEnd;
  } catch (error) {
    console.error("Free tier check failed:", error);
    return false;
  }
}

export function getFreeTierLimits(): FreeTierConfig {
  return FREE_TIER_CONFIG;
}
```

---

## 4. EULA Documentation

### 4.1 Standard Contract Requirements

AWS Marketplace offers a Standard Contract for Software (SCFS) that simplifies procurement:

#### Standard Contract Benefits

- Pre-negotiated terms accepted by enterprise buyers
- Faster procurement cycles
- Reduced legal review time
- Compatible with AWS Enterprise Agreements

#### Enabling Standard Contract

1. Navigate to AWS Marketplace Management Portal
2. Select your product listing
3. Go to "Offers" > "Agreement Templates"
4. Enable "AWS Marketplace Standard Contract"
5. Configure any addendums

### 4.2 Custom EULA Template

```markdown
# SKILLSMITH END USER LICENSE AGREEMENT

**Effective Date:** [DATE]
**Version:** 1.0

## 1. DEFINITIONS

1.1 "Agreement" means this End User License Agreement.

1.2 "Customer" means the entity that subscribes to the Service through AWS Marketplace.

1.3 "Service" means the Skillsmith AI Skills Development Platform.

1.4 "Users" means individuals authorized by Customer to access the Service.

## 2. LICENSE GRANT

2.1 **Subscription License.** Subject to the terms of this Agreement, Skillsmith grants Customer a non-exclusive, non-transferable license to access and use the Service during the Subscription Term.

2.2 **User Limits.** Customer may permit the number of Users specified in the applicable AWS Marketplace order to access the Service.

2.3 **Restrictions.** Customer shall not:
   - Sublicense, sell, or transfer the Service
   - Reverse engineer or decompile the Service
   - Use the Service for illegal purposes
   - Remove proprietary notices from the Service

## 3. CUSTOMER OBLIGATIONS

3.1 **Account Security.** Customer is responsible for maintaining the security of User credentials.

3.2 **Acceptable Use.** Customer agrees to use the Service in accordance with the Acceptable Use Policy.

3.3 **Data.** Customer retains ownership of all data submitted to the Service.

## 4. PRICING AND PAYMENT

4.1 **Fees.** Customer agrees to pay the fees specified in AWS Marketplace.

4.2 **Billing.** All billing is processed through AWS Marketplace.

4.3 **Taxes.** Fees are exclusive of applicable taxes.

## 5. TERM AND TERMINATION

5.1 **Term.** This Agreement begins on the Effective Date and continues for the Subscription Term.

5.2 **Termination.** Either party may terminate this Agreement:
   - For cause with 30 days written notice
   - For material breach not cured within 30 days

5.3 **Effect of Termination.** Upon termination:
   - Customer's access to the Service will cease
   - Customer may export data within 30 days

## 6. WARRANTIES AND DISCLAIMERS

6.1 **Service Warranty.** Skillsmith warrants that the Service will perform substantially as described in the documentation.

6.2 **DISCLAIMER.** EXCEPT AS EXPRESSLY PROVIDED, THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND.

## 7. LIMITATION OF LIABILITY

7.1 **Cap.** Neither party's liability shall exceed the fees paid in the 12 months preceding the claim.

7.2 **Exclusions.** Neither party is liable for indirect, incidental, or consequential damages.

## 8. CONFIDENTIALITY

8.1 Each party agrees to protect the other's Confidential Information using reasonable care.

## 9. DATA PROTECTION

9.1 **Processing.** Skillsmith will process Customer data in accordance with the Data Processing Addendum.

9.2 **Security.** Skillsmith maintains industry-standard security measures.

## 10. GENERAL PROVISIONS

10.1 **Governing Law.** This Agreement is governed by the laws of Delaware, USA.

10.2 **Entire Agreement.** This Agreement constitutes the entire agreement between the parties.

10.3 **Amendments.** This Agreement may only be amended in writing.

---

**SKILLSMITH, INC.**

Contact: legal@skillsmith.io
```

#### Data Processing Addendum (DPA)

```markdown
# DATA PROCESSING ADDENDUM

This Data Processing Addendum ("DPA") supplements the End User License Agreement.

## 1. DEFINITIONS

"Personal Data" means information relating to an identified or identifiable individual.

"Processing" means any operation performed on Personal Data.

## 2. DATA PROCESSING

2.1 **Role.** Skillsmith processes Personal Data as a Processor on behalf of Customer.

2.2 **Instructions.** Skillsmith will process Personal Data only on documented instructions.

2.3 **Personnel.** Skillsmith ensures personnel processing Personal Data are bound by confidentiality.

## 3. SECURITY MEASURES

Skillsmith implements:
- Encryption in transit (TLS 1.3)
- Encryption at rest (AES-256)
- Access controls and authentication
- Regular security assessments
- Incident response procedures

## 4. SUB-PROCESSORS

4.1 **Authorization.** Customer authorizes Skillsmith to engage sub-processors.

4.2 **List.** Current sub-processors: AWS, Supabase.

## 5. DATA SUBJECT RIGHTS

Skillsmith will assist Customer in responding to data subject requests.

## 6. DATA BREACH NOTIFICATION

Skillsmith will notify Customer of data breaches within 72 hours.

## 7. DATA DELETION

Upon termination, Skillsmith will delete Personal Data within 30 days.
```

---

## 5. Usage Metering Integration

### 5.1 AWS Marketplace Metering Service

The AWS Marketplace Metering Service enables usage-based billing for SaaS products.

#### Service Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Skillsmith Application                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   User       │    │   Usage      │    │   Metering   │  │
│  │   Activity   │───▶│   Tracker    │───▶│   Agent      │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                 │            │
└─────────────────────────────────────────────────│────────────┘
                                                  │
                                                  ▼
                          ┌──────────────────────────────────┐
                          │  AWS Marketplace Metering API     │
                          ├──────────────────────────────────┤
                          │  • MeterUsage                     │
                          │  • BatchMeterUsage                │
                          │  • RegisterUsage                  │
                          └──────────────────────────────────┘
```

### 5.2 Dimension Configuration

#### Skillsmith Metering Dimensions

```json
{
  "ProductCode": "skillsmith-enterprise",
  "Dimensions": [
    {
      "Name": "team_users",
      "Description": "Team tier users",
      "Type": "Counter",
      "Unit": "user",
      "Price": 25.00
    },
    {
      "Name": "enterprise_users",
      "Description": "Enterprise tier users",
      "Type": "Counter",
      "Unit": "user",
      "Price": 69.00
    },
    {
      "Name": "api_calls",
      "Description": "API calls over free tier",
      "Type": "Counter",
      "Unit": "1000calls",
      "Price": 0.10
    },
    {
      "Name": "storage_gb",
      "Description": "Storage over free tier",
      "Type": "Gauge",
      "Unit": "GB-month",
      "Price": 0.50
    }
  ]
}
```

### 5.3 API Integration Code

#### Metering Client Setup

```typescript
// src/metering/aws-metering-client.ts

import {
  MarketplaceMeteringClient,
  MeterUsageCommand,
  BatchMeterUsageCommand,
  RegisterUsageCommand,
  UsageRecord
} from "@aws-sdk/client-marketplace-metering";

interface MeteringConfig {
  productCode: string;
  region: string;
  publicKeyVersion: number;
}

export class SkillsmithMeteringClient {
  private client: MarketplaceMeteringClient;
  private config: MeteringConfig;

  constructor(config: MeteringConfig) {
    this.config = config;
    this.client = new MarketplaceMeteringClient({
      region: config.region
    });
  }

  /**
   * Register initial usage when customer subscribes
   */
  async registerUsage(): Promise<string> {
    const command = new RegisterUsageCommand({
      ProductCode: this.config.productCode,
      PublicKeyVersion: this.config.publicKeyVersion
    });

    const response = await this.client.send(command);
    return response.Signature || "";
  }

  /**
   * Report hourly usage for a single dimension
   */
  async meterUsage(
    dimension: string,
    quantity: number,
    timestamp?: Date
  ): Promise<void> {
    const command = new MeterUsageCommand({
      ProductCode: this.config.productCode,
      Timestamp: timestamp || new Date(),
      UsageDimension: dimension,
      UsageQuantity: quantity,
      DryRun: process.env.NODE_ENV !== "production"
    });

    await this.client.send(command);
  }

  /**
   * Report batch usage for multiple customers/dimensions
   */
  async batchMeterUsage(
    usageRecords: UsageRecord[]
  ): Promise<{ successful: number; failed: number }> {
    const command = new BatchMeterUsageCommand({
      ProductCode: this.config.productCode,
      UsageRecords: usageRecords
    });

    const response = await this.client.send(command);

    return {
      successful: response.Results?.filter(r => r.Status === "Success").length || 0,
      failed: response.UnprocessedRecords?.length || 0
    };
  }
}
```

#### Usage Tracking Service

```typescript
// src/metering/usage-tracker.ts

import { SkillsmithMeteringClient } from "./aws-metering-client";
import { db } from "../database";

interface UsageSnapshot {
  customerId: string;
  tier: "team" | "enterprise";
  activeUsers: number;
  apiCalls: number;
  storageGB: number;
  timestamp: Date;
}

export class UsageTracker {
  private meteringClient: SkillsmithMeteringClient;
  private batchSize = 25; // AWS limit

  constructor() {
    this.meteringClient = new SkillsmithMeteringClient({
      productCode: process.env.AWS_MARKETPLACE_PRODUCT_CODE!,
      region: process.env.AWS_REGION || "us-east-1",
      publicKeyVersion: 1
    });
  }

  /**
   * Collect usage from all customers
   */
  async collectUsage(): Promise<UsageSnapshot[]> {
    const customers = await db.query(`
      SELECT
        c.id as customer_id,
        c.tier,
        COUNT(DISTINCT u.id) as active_users,
        SUM(al.api_calls) as api_calls,
        c.storage_used_gb as storage_gb
      FROM customers c
      LEFT JOIN users u ON u.customer_id = c.id AND u.last_active > NOW() - INTERVAL '1 hour'
      LEFT JOIN api_logs al ON al.customer_id = c.id AND al.timestamp > NOW() - INTERVAL '1 hour'
      WHERE c.marketplace_subscription_id IS NOT NULL
      GROUP BY c.id, c.tier, c.storage_used_gb
    `);

    return customers.rows.map(row => ({
      customerId: row.customer_id,
      tier: row.tier,
      activeUsers: parseInt(row.active_users) || 0,
      apiCalls: parseInt(row.api_calls) || 0,
      storageGB: parseFloat(row.storage_gb) || 0,
      timestamp: new Date()
    }));
  }

  /**
   * Report usage to AWS Marketplace
   */
  async reportUsage(): Promise<void> {
    const snapshots = await this.collectUsage();

    // Group into batches
    const batches: UsageSnapshot[][] = [];
    for (let i = 0; i < snapshots.length; i += this.batchSize) {
      batches.push(snapshots.slice(i, i + this.batchSize));
    }

    for (const batch of batches) {
      const usageRecords = batch.flatMap(snapshot => {
        const records = [];

        // User-based billing
        const userDimension = snapshot.tier === "enterprise"
          ? "enterprise_users"
          : "team_users";

        if (snapshot.activeUsers > 0) {
          records.push({
            CustomerIdentifier: snapshot.customerId,
            Dimension: userDimension,
            Quantity: snapshot.activeUsers,
            Timestamp: snapshot.timestamp
          });
        }

        // Overage API calls (over 10k for team, unlimited for enterprise)
        if (snapshot.tier === "team" && snapshot.apiCalls > 10000) {
          records.push({
            CustomerIdentifier: snapshot.customerId,
            Dimension: "api_calls",
            Quantity: Math.ceil((snapshot.apiCalls - 10000) / 1000),
            Timestamp: snapshot.timestamp
          });
        }

        // Overage storage (over 10GB for team, 100GB for enterprise)
        const storageLimit = snapshot.tier === "enterprise" ? 100 : 10;
        if (snapshot.storageGB > storageLimit) {
          records.push({
            CustomerIdentifier: snapshot.customerId,
            Dimension: "storage_gb",
            Quantity: Math.ceil(snapshot.storageGB - storageLimit),
            Timestamp: snapshot.timestamp
          });
        }

        return records;
      });

      if (usageRecords.length > 0) {
        const result = await this.meteringClient.batchMeterUsage(usageRecords);
        console.log(`Metering batch: ${result.successful} successful, ${result.failed} failed`);
      }
    }
  }
}
```

#### Scheduled Metering Job

```typescript
// src/metering/scheduler.ts

import { CronJob } from "cron";
import { UsageTracker } from "./usage-tracker";

const usageTracker = new UsageTracker();

// Report usage every hour
const hourlyMeteringJob = new CronJob(
  "0 * * * *", // Every hour at minute 0
  async () => {
    console.log("Starting hourly usage metering...");
    try {
      await usageTracker.reportUsage();
      console.log("Hourly usage metering completed");
    } catch (error) {
      console.error("Metering failed:", error);
      // Alert on-call team
      await alertOnCall("Metering job failed", error);
    }
  },
  null,
  false,
  "UTC"
);

// Start the job
hourlyMeteringJob.start();

export { hourlyMeteringJob };
```

#### Container Entrypoint with Metering

```bash
#!/bin/bash
# scripts/metering-agent.sh

set -e

# Verify AWS Marketplace credentials
verify_marketplace_credentials() {
    echo "Verifying AWS Marketplace credentials..."

    if [ -z "$AWS_MARKETPLACE_PRODUCT_CODE" ]; then
        echo "ERROR: AWS_MARKETPLACE_PRODUCT_CODE not set"
        exit 1
    fi

    # Register usage to validate credentials
    node -e "
    const { MarketplaceMeteringClient, RegisterUsageCommand } = require('@aws-sdk/client-marketplace-metering');
    const client = new MarketplaceMeteringClient({ region: process.env.AWS_REGION || 'us-east-1' });
    client.send(new RegisterUsageCommand({
        ProductCode: process.env.AWS_MARKETPLACE_PRODUCT_CODE,
        PublicKeyVersion: 1
    })).then(() => console.log('Marketplace registration verified'))
      .catch(err => {
          console.error('Marketplace registration failed:', err.message);
          process.exit(1);
      });
    "
}

# Start metering background process
start_metering_agent() {
    echo "Starting metering agent..."
    node dist/metering/scheduler.js &
    METERING_PID=$!
    echo "Metering agent started (PID: $METERING_PID)"
}

# Graceful shutdown
cleanup() {
    echo "Shutting down..."
    if [ -n "$METERING_PID" ]; then
        kill $METERING_PID 2>/dev/null || true
    fi
    exit 0
}

trap cleanup SIGTERM SIGINT

# Main execution
verify_marketplace_credentials
start_metering_agent

# Execute the main application
exec "$@"
```

---

## 6. Launch Checklist

### 6.1 Pre-Submission Checklist

#### Seller Account

- [ ] AWS Marketplace seller registration complete
- [ ] Tax interview completed and verified
- [ ] Banking information configured
- [ ] Disbursement account verified with test deposit

#### Product Information

- [ ] Product title (max 72 characters)
- [ ] Short description (max 200 characters)
- [ ] Full description (max 20,000 characters)
- [ ] Product logo (120x120 PNG)
- [ ] At least 3 screenshots (1920x1080 minimum)
- [ ] Product categories selected
- [ ] Keywords added
- [ ] Support contact information

#### Container

- [ ] Docker image pushed to ECR
- [ ] Multi-architecture support (AMD64, ARM64)
- [ ] Security scan passed (no critical/high CVEs)
- [ ] Non-root user configured
- [ ] Health check implemented
- [ ] Environment variables documented

#### Pricing

- [ ] Pricing model selected
- [ ] Dimension configuration complete
- [ ] Free trial configured (optional)
- [ ] Annual discount configured (optional)

#### Legal

- [ ] EULA document uploaded
- [ ] Data Processing Addendum included
- [ ] Standard Contract enabled (optional)
- [ ] Privacy policy URL provided

#### Technical

- [ ] Metering integration tested
- [ ] Customer onboarding flow tested
- [ ] Subscription lifecycle handling (subscribe, unsubscribe, upgrade)
- [ ] Error handling and logging

#### Documentation

- [ ] User guide PDF
- [ ] Deployment guide
- [ ] API documentation
- [ ] Troubleshooting guide
- [ ] FAQ document

### 6.2 AWS Review Process

#### Submission Steps

1. **Create Product Request**
   - Navigate to AWS Marketplace Management Portal
   - Select "Products" > "Create Product"
   - Choose "Container" product type

2. **Complete Product Form**
   - Fill in all required fields
   - Upload assets and documentation
   - Configure pricing

3. **Submit for Review**
   - Click "Submit for review"
   - Acknowledge compliance requirements

#### Review Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| Initial Triage | 1-2 days | Basic validation and assignment |
| Technical Review | 3-5 days | Container scanning and testing |
| Business Review | 2-3 days | Pricing and legal review |
| Final Approval | 1-2 days | Final checks and publication |

**Total: 7-12 business days (typical)**

#### Common Rejection Reasons

| Issue | Solution |
|-------|----------|
| Security vulnerabilities | Update base image, fix CVEs |
| Missing documentation | Add required guides |
| Pricing configuration errors | Review dimension setup |
| EULA issues | Use AWS-approved template |
| Logo/screenshot quality | Re-upload high-resolution assets |

### 6.3 Post-Launch Monitoring

#### Key Metrics Dashboard

```typescript
// src/monitoring/marketplace-metrics.ts

interface MarketplaceMetrics {
  subscriptions: {
    total: number;
    new: number;
    churned: number;
    conversions: number;
  };
  revenue: {
    mrr: number;
    arr: number;
    averageRevenuePerUser: number;
  };
  usage: {
    activeUsers: number;
    apiCalls: number;
    storageGB: number;
  };
  support: {
    ticketsOpen: number;
    avgResponseTime: number;
    csat: number;
  };
}

export class MarketplaceMonitor {
  async collectMetrics(): Promise<MarketplaceMetrics> {
    // Aggregate metrics from various sources
    return {
      subscriptions: await this.getSubscriptionMetrics(),
      revenue: await this.getRevenueMetrics(),
      usage: await this.getUsageMetrics(),
      support: await this.getSupportMetrics()
    };
  }

  async reportToCloudWatch(metrics: MarketplaceMetrics): Promise<void> {
    // Push custom metrics to CloudWatch for monitoring
  }
}
```

#### Alerting Configuration

```yaml
# cloudwatch-alarms.yaml

alarms:
  - name: HighChurnRate
    metric: ChurnRate
    threshold: 5
    period: 86400  # 24 hours
    comparison: GreaterThanThreshold
    actions:
      - notify-product-team

  - name: MeteringFailures
    metric: MeteringErrorCount
    threshold: 10
    period: 3600  # 1 hour
    comparison: GreaterThanThreshold
    actions:
      - notify-engineering
      - page-oncall

  - name: LowConversionRate
    metric: TrialConversionRate
    threshold: 10
    period: 604800  # 7 days
    comparison: LessThanThreshold
    actions:
      - notify-product-team

  - name: HighSupportVolume
    metric: SupportTicketCount
    threshold: 100
    period: 86400  # 24 hours
    comparison: GreaterThanThreshold
    actions:
      - notify-support-lead
```

#### Customer Feedback Loop

1. **In-App Feedback**
   - NPS surveys (quarterly)
   - Feature request collection
   - Bug reporting

2. **AWS Marketplace Reviews**
   - Monitor and respond to reviews
   - Address negative feedback promptly
   - Encourage satisfied customers to review

3. **Usage Analytics**
   - Feature adoption tracking
   - User journey analysis
   - Churn prediction

#### Version Updates

```bash
#!/bin/bash
# scripts/marketplace-update.sh

VERSION=$1
RELEASE_NOTES=$2

echo "Publishing version $VERSION to AWS Marketplace..."

# 1. Push new container image
./scripts/tag-and-push.sh $VERSION

# 2. Create new product version
aws marketplace-catalog start-change-set \
    --catalog AWSMarketplace \
    --change-set '[
        {
            "ChangeType": "AddDeliveryOptions",
            "Entity": {
                "Type": "ContainerProduct@1.0",
                "Identifier": "'"$PRODUCT_ID"'"
            },
            "Details": "{\"DeliveryOptions\": [{\"Details\": {\"EcrDeliveryOptionDetails\": {\"ContainerImages\": [\"'"$ECR_URI:$VERSION"'\"], \"Description\": \"'"$RELEASE_NOTES"'\"}}}]}"
        }
    ]'

echo "Version $VERSION submitted for review"
```

---

## Appendix A: Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_MARKETPLACE_PRODUCT_CODE` | Yes | AWS Marketplace product code |
| `AWS_REGION` | No | AWS region (default: us-east-1) |
| `AWS_ACCESS_KEY_ID` | Yes* | AWS credentials (*if not using IAM role) |
| `AWS_SECRET_ACCESS_KEY` | Yes* | AWS credentials (*if not using IAM role) |

## Appendix B: API Reference

### Metering API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `RegisterUsage` | POST | Register new subscription |
| `MeterUsage` | POST | Report single usage record |
| `BatchMeterUsage` | POST | Report multiple usage records |
| `ResolveCustomer` | POST | Resolve customer from token |

## Appendix C: Support Resources

- [AWS Marketplace Seller Guide](https://docs.aws.amazon.com/marketplace/latest/userguide/what-is-marketplace.html)
- [Container Product Listing](https://docs.aws.amazon.com/marketplace/latest/userguide/container-products.html)
- [Metering Service API](https://docs.aws.amazon.com/marketplacemetering/latest/APIReference/Welcome.html)
- [Seller Support](https://aws.amazon.com/marketplace/management/contact-us/)

---

**Document Version:** 1.0
**Last Updated:** January 2026
**Maintained By:** Skillsmith Platform Team
