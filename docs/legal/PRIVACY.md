# Privacy Policy

**Skillsmith - Claude Code Skill Discovery Tool**

**Effective Date:** January 2, 2025
**Last Updated:** January 2, 2025
**Version:** 1.0.0

---

## 1. Introduction

This Privacy Policy describes how Skillsmith ("we," "us," "our," or the "Service") collects, uses, stores, and protects information when you use our MCP (Model Context Protocol) server tool for discovering and installing Claude Code skills.

We are committed to protecting your privacy and ensuring transparency about our data practices. This policy complies with the General Data Protection Regulation (GDPR), the California Consumer Privacy Act (CCPA), and other applicable privacy laws.

By using Skillsmith, you acknowledge that you have read and understood this Privacy Policy.

---

## 2. Information We Collect

### 2.1 Telemetry Data

We collect anonymous telemetry data to improve the Service. This includes:

- **Command Usage:** Types of commands executed (e.g., search, install, list)
- **Skill Installation Data:** Which skills are installed, updated, or removed
- **Feature Usage Patterns:** Which features are most frequently used
- **Session Duration:** How long the Service is actively used

### 2.2 Performance Metrics

We collect technical performance data to ensure Service reliability:

- **Response Times:** How quickly the Service responds to requests
- **Resource Utilization:** Memory and CPU usage patterns
- **Latency Measurements:** Network and processing delays
- **Throughput Statistics:** Volume of operations processed

### 2.3 Error Reports

When errors occur, we collect diagnostic information:

- **Error Types:** Classification of errors encountered
- **Stack Traces:** Technical information about error origins (sanitized to remove any personal data)
- **Environment Context:** Operating system type, Node.js version, and Service version
- **Timestamp:** When the error occurred

### 2.4 Information We Do NOT Collect

By default, Skillsmith does **not** collect:

- **Personal Identifiable Information (PII):** Names, email addresses, phone numbers, or physical addresses
- **Authentication Credentials:** API keys, tokens, passwords, or secrets
- **File Contents:** The actual content of your code, configurations, or documents
- **IP Addresses:** Your network address is not logged or stored
- **Location Data:** Geographic or location information
- **Browsing History:** Websites visited or search history outside the Service
- **Communication Content:** Messages, prompts, or conversations with Claude

---

## 3. Legal Basis for Processing (GDPR)

Under the GDPR, we process data based on the following legal grounds:

| Data Type | Legal Basis | Justification |
|-----------|-------------|---------------|
| Telemetry Data | Legitimate Interest | Service improvement and optimization |
| Performance Metrics | Legitimate Interest | Ensuring Service reliability and quality |
| Error Reports | Legitimate Interest | Bug fixing and Service stability |

You may opt out of telemetry collection at any time (see Section 7.5).

---

## 4. How We Use Your Information

### 4.1 Service Improvement

- Identifying popular features and skills
- Optimizing Service performance
- Prioritizing development efforts
- Understanding usage patterns

### 4.2 Technical Operations

- Diagnosing and fixing bugs
- Monitoring Service health
- Preventing Service degradation
- Capacity planning

### 4.3 Analytics and Reporting

- Generating aggregate usage statistics
- Creating internal performance reports
- Measuring Service adoption
- Tracking feature effectiveness

We do **not** use collected data for:

- Advertising or marketing profiling
- Selling to third parties
- Building personal profiles
- Targeted content delivery

---

## 5. Data Storage and Retention

### 5.1 Storage Location

All data is stored on secure servers with industry-standard encryption:

- Data at rest: AES-256 encryption
- Data in transit: TLS 1.3 encryption

### 5.2 Retention Periods

| Data Type | Retention Period | Justification |
|-----------|------------------|---------------|
| Telemetry Data | 90 days | Trend analysis and feature planning |
| Performance Metrics | 30 days | Real-time monitoring and alerting |
| Error Reports | 180 days | Bug tracking and resolution cycles |
| Aggregated Statistics | Indefinitely | Historical analysis (fully anonymized) |

### 5.3 Data Deletion

After the retention period expires, data is:

1. Automatically purged from active systems
2. Removed from backup systems within 30 days
3. Permanently deleted with no recovery possible

---

## 6. Third-Party Sharing

### 6.1 Core Product Policy

**Skillsmith does not sell, rent, or share your data with third parties for their own purposes.**

### 6.2 Limited Exceptions

We may share data only in the following circumstances:

| Circumstance | Data Shared | Safeguards |
|--------------|-------------|------------|
| Legal Requirements | As required by law | Minimum necessary disclosure |
| Service Providers | Anonymized metrics only | Data processing agreements |
| Business Transfer | All data (in acquisition) | Continued privacy protections |

### 6.3 Service Providers

If we use service providers for infrastructure (e.g., cloud hosting), they:

- Are bound by data processing agreements
- Cannot use data for their own purposes
- Must maintain equivalent security standards
- Are prohibited from further sharing

---

## 7. Your Rights

### 7.1 Rights Under GDPR (European Users)

If you are located in the European Economic Area (EEA), United Kingdom, or Switzerland, you have the following rights:

| Right | Description |
|-------|-------------|
| **Access** | Request a copy of data we hold about you |
| **Rectification** | Request correction of inaccurate data |
| **Erasure** | Request deletion of your data ("right to be forgotten") |
| **Restriction** | Request limitation of data processing |
| **Portability** | Receive your data in a structured, machine-readable format |
| **Objection** | Object to processing based on legitimate interests |
| **Withdraw Consent** | Withdraw consent at any time where processing is based on consent |
| **Lodge Complaint** | File a complaint with your local data protection authority |

### 7.2 Rights Under CCPA (California Residents)

If you are a California resident, you have the following rights under the CCPA:

| Right | Description |
|-------|-------------|
| **Know** | Know what personal information is collected |
| **Access** | Access your personal information |
| **Delete** | Request deletion of your personal information |
| **Opt-Out** | Opt out of the sale of personal information (Note: We do not sell data) |
| **Non-Discrimination** | Not be discriminated against for exercising your rights |

**CCPA Categories of Information:**

- We collect: Internet or electronic network activity information (telemetry)
- We do not collect: Identifiers, commercial information, biometric data, geolocation, sensory data, professional information, education information, or inferences

### 7.3 Exercising Your Rights

To exercise any of these rights, contact us at the address provided in Section 11. We will respond to your request within:

- **GDPR:** 30 days (extendable by 60 days for complex requests)
- **CCPA:** 45 days (extendable by 45 days for complex requests)

### 7.4 Verification

To protect your privacy, we may need to verify your identity before processing your request. This may include:

- Confirming information you previously provided
- Requesting additional verification documentation

### 7.5 Opting Out of Telemetry

You can disable telemetry collection at any time:

**Option 1: Configuration File**
```json
{
  "telemetry": {
    "enabled": false
  }
}
```

**Option 2: Environment Variable**
```bash
export SKILLSMITH_TELEMETRY_DISABLED=true
```

**Option 3: Command Line**
```bash
skillsmith config set telemetry.enabled false
```

When telemetry is disabled:
- No usage data is collected or transmitted
- Error reports are stored locally only
- All Service features remain fully functional

---

## 8. Data Security

### 8.1 Technical Measures

We implement the following security measures:

- **Encryption:** All data encrypted at rest (AES-256) and in transit (TLS 1.3)
- **Access Control:** Role-based access with principle of least privilege
- **Authentication:** Multi-factor authentication for system access
- **Monitoring:** Continuous security monitoring and alerting
- **Auditing:** Comprehensive logging of data access

### 8.2 Organizational Measures

- Regular security training for personnel
- Background checks for employees with data access
- Incident response procedures
- Regular security assessments and penetration testing

### 8.3 Data Breach Notification

In the event of a data breach that affects your rights and freedoms:

- **GDPR:** We will notify the relevant supervisory authority within 72 hours and affected individuals without undue delay
- **CCPA:** We will notify affected California residents as required by law

---

## 9. International Data Transfers

### 9.1 Transfer Mechanisms

If data is transferred outside your jurisdiction, we ensure adequate protection through:

- Standard Contractual Clauses (SCCs) approved by the European Commission
- Adequacy decisions where applicable
- Additional supplementary measures as needed

### 9.2 Your Choices

You may object to international data transfers by disabling telemetry (see Section 7.5).

---

## 10. Children's Privacy

Skillsmith is not directed at children under the age of 16 (or the applicable age of digital consent in your jurisdiction). We do not knowingly collect personal information from children.

If you believe we have inadvertently collected information from a child, please contact us immediately, and we will promptly delete such information.

---

## 11. Contact Information

For privacy-related inquiries, requests, or complaints:

**Data Controller / Privacy Contact:**

```
[COMPANY NAME]
[STREET ADDRESS]
[CITY, STATE/PROVINCE, POSTAL CODE]
[COUNTRY]

Email: [PRIVACY_EMAIL]
Privacy Portal: [PRIVACY_PORTAL_URL]
```

**Data Protection Officer (if applicable):**

```
[DPO NAME]
Email: [DPO_EMAIL]
```

**EU Representative (for non-EU organizations):**

```
[EU REPRESENTATIVE NAME]
[ADDRESS]
Email: [EU_REP_EMAIL]
```

**Response Time:** We aim to respond to all inquiries within 5 business days.

---

## 12. Changes to This Policy

### 12.1 Notification of Changes

We may update this Privacy Policy from time to time. When we make changes:

- **Material Changes:** We will provide prominent notice (e.g., in-app notification, changelog entry) at least 30 days before the changes take effect
- **Minor Changes:** Updates will be reflected in the "Last Updated" date at the top of this document

### 12.2 Review Recommendation

We encourage you to review this Privacy Policy periodically to stay informed about our data practices.

### 12.3 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | January 2, 2025 | Initial release |

---

## 13. Additional Information

### 13.1 Do Not Track

Skillsmith does not currently respond to "Do Not Track" browser signals. However, you can disable telemetry using the methods described in Section 7.5.

### 13.2 Automated Decision-Making

Skillsmith does not engage in automated decision-making or profiling that produces legal effects or similarly significant effects on users.

### 13.3 Cookies and Tracking

As a command-line tool, Skillsmith does not use cookies or web tracking technologies.

### 13.4 Open Source Transparency

Skillsmith's data collection practices are documented in our source code. You can review exactly what data is collected by examining our telemetry module.

---

## 14. Definitions

| Term | Definition |
|------|------------|
| **Personal Data** | Any information relating to an identified or identifiable natural person |
| **Processing** | Any operation performed on personal data |
| **Data Controller** | Entity that determines the purposes and means of processing |
| **Data Processor** | Entity that processes data on behalf of the controller |
| **Telemetry** | Automated collection of technical and usage data |
| **PII** | Personally Identifiable Information |

---

## 15. Legal Disclosures

### 15.1 GDPR Compliance Statement

This Privacy Policy is designed to comply with the General Data Protection Regulation (EU) 2016/679. For EU residents, the data controller is [COMPANY NAME] at the address listed in Section 11.

### 15.2 CCPA Compliance Statement

This Privacy Policy is designed to comply with the California Consumer Privacy Act of 2018 (as amended by the CPRA). Skillsmith does not sell personal information as defined by the CCPA.

### 15.3 Other Jurisdictions

We endeavor to comply with privacy laws in all jurisdictions where we operate. If you have questions about compliance with your local laws, please contact us.

---

**By using Skillsmith, you acknowledge that you have read and understood this Privacy Policy.**

---

*This document is provided for informational purposes and does not constitute legal advice. Organizations should consult with qualified legal counsel to ensure compliance with applicable privacy laws.*
