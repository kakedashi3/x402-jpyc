# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest (main) | ✅ |

## Reporting a Vulnerability

This repository has GitHub Private vulnerability reporting enabled.

If you discover a security vulnerability, please do NOT
open a public issue. Instead, report it privately:

**GitHub Private Reporting (Recommended):**
https://github.com/kakedashi3/x402-jpyc/security/advisories/new

Please include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- Acknowledgement: within 48 hours
- Initial assessment: within 7 days
- Fix: prioritized based on severity

## Scope

In scope:
- api/verify.ts (facilitator endpoint)
- lib/jpyc.ts (JPYC verification logic)
- lib/replay.ts (replay protection)

Out of scope:
- Vercel infrastructure vulnerabilities
- Polygon network vulnerabilities
- JPYC contract vulnerabilities
