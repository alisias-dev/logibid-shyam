# FleexBid — Comprehensive System Architecture & Feature Specification

> **Version:** 1.0.0  
> **Date:** August 2026  
> **Target Audience:** Developers, Software Architects, and System Integrators building or recreating the FleexBid platform from scratch.

---

## 1. Executive Summary & Product Vision

**FleexBid** is an enterprise-grade logistics procurement and freight reverse-auction marketplace. The platform enables corporate shippers and logistics managers to post freight requirements, invite verified transport partners, and execute real-time competitive reverse auctions where transporters submit descending rate bids.

### Key Objectives & Value Proposition
1. **Automated Procurement & Cost Optimization:** Replaces manual phone call / WhatsApp negotiation with structured, real-time descending reverse auctions, generating measurable cost savings against market target rates.
2. **Confidentiality & Anonymity:** Transporters compete fiercely without knowing competitor identities or rates—they only see their live competition rank (L1, L2, etc.) and their own rate.
3. **Smart Rate & Fleet Intelligence:** Integrated AI engine powered by Google Gemini predicts market rates, calculates optimal target rates, matches fleet capabilities to loads, and drafts supplier negotiation messages.
4. **Resilient Multi-Channel Notifications:** Automatically dispatches alerts via SMS (Twilio/Mock), Email (SMTP/Nodemailer/Resend), and WhatsApp upon requirement publication, bid award, or bid displacement.
5. **Dual-Mode Enterprise Data Layer:** Fully persistent PostgreSQL integration with automatic schema migration, parameter sanitization, and fallback snapshot diffing.

---

## 2. Technology Stack & Architectural Overview

### 2.1 System Architecture Diagram

```
+-----------------------------------------------------------------------+
|                             CLIENT LAYER                              |
|   React 19 + TypeScript + Vite + Tailwind CSS v4 + Motion + Lucide   |
|   - SPA Routing (React Router v7)                                     |
|   - Auth & Session Context (JWT + LocalStorage + Cookies)             |
|   - Real-Time Socket.io Client Connection                             |
+-----------------------------------+-----------------------------------+
                                    | HTTP / WebSockets
                                    v
+-----------------------------------------------------------------------+
|                             SERVER LAYER                              |
|   Node.js + Express v4 + Socket.io Server + tsx / esbuild             |
|                                                                       |
|   [Middlewares]                                                       |
|   - CORS & Dynamic Origin Handler                                     |
|   - Rate Limiters (Login, Bidding, Requirements)                      |
|   - JWT Auth & In-Memory Auth Cache (15s TTL)                         |
|   - Role-Based Access Control (RBAC) + Spectator Guard                |
|                                                                       |
|   [Services & Controllers]                                            |
|   - Auth Engine (JWT, Password Hashing, Session Rotation)             |
|   - Bidding & Ranking Engine (1-2-2-4 Competition Ranking)            |
|   - Auto-Close & Award Cron (10s interval)                            |
|   - Multi-Channel Notifications (Twilio SMS, Nodemailer Email)        |
|   - AI Advisor Router (Google Gemini API: gemini-3.5-flash)            |
|   - Audit Logging Engine                                              |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
|                            DATABASE LAYER                             |
|   PostgreSQL (Neon Postgres / standard pg.Pool)                       |
|   - Auto Schema Migration & Indexing on Startup                       |
|   - Dual-Mode Parameterized Queries & Snapshot Diff-Sync              |
+-----------------------------------------------------------------------+
```

### 2.2 Technology Breakdown

| Component | Technology / Library | Version / Details |
| :--- | :--- | :--- |
| **Frontend Framework** | React | `^19.0.1` |
| **Language** | TypeScript | `~5.8.2` |
| **Build Tool & Bundler** | Vite (Client) + esbuild (Server) | `^6.2.3` / `^0.25.0` |
| **Styling** | Tailwind CSS v4 | `@tailwindcss/vite ^4.1.14` |
| **Icons & Animations** | Lucide React + Motion | `lucide-react ^0.546.0`, `motion ^12.23.24` |
| **Routing** | React Router DOM | `^7.18.1` |
| **Backend Framework** | Express.js | `^4.21.2` |
| **Real-Time Layer** | Socket.io / Socket.io-client | `^4.8.3` |
| **Database Driver** | `pg` (Node-PostgreSQL) | `^8.22.0` |
| **Security & Auth** | `jsonwebtoken`, `bcryptjs`, `cookie-parser` | JWT tokens, bcrypt cost 10 |
| **Rate Limiting** | `express-rate-limit` | `^8.5.2` |
| **AI Integration** | `@google/genai` | `^2.4.0` (Gemini 3.5 Flash) |
| **Email Dispatches** | `nodemailer` | `^9.0.3` |
| **Dev Execution** | `tsx` | `^4.21.0` |

---

## 3. Data Schema & Domain Models

The database schema is designed for PostgreSQL (`pg.Pool`). Column names in PostgreSQL use `snake_case`, while the application layer normalizes keys to camelCase.

### 3.1 Entity Definitions & SQL Schemas

#### 1. `users` (Corporate Logistics Staff & Super Admins)
```sql
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(255) PRIMARY KEY,          -- Format: usr_<hash>
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,            -- 'SUPER_ADMIN' | 'LOGISTICS'
  name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL           -- 'AUTHORIZED' | 'APPROVED' | 'BLOCKED'
);
```

#### 2. `transporters` (Vendor Companies / Carrier Partners)
```sql
CREATE TABLE IF NOT EXISTS transporters (
  id VARCHAR(255) PRIMARY KEY,          -- Format: tr_<hash>
  company_name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  mobile_number VARCHAR(50) NOT NULL,
  gst_number VARCHAR(50) NOT NULL,
  pan_number VARCHAR(50) NOT NULL,
  vehicle_types TEXT[] NOT NULL,        -- e.g. ['32ft MXL', '20ft Container']
  operating_states TEXT[] NOT NULL,     -- e.g. ['Maharashtra', 'Gujarat']
  preferred_routes TEXT[] NOT NULL,     -- e.g. ['Mumbai -> Delhi']
  status VARCHAR(50) NOT NULL,          -- 'ACTIVE' | 'INACTIVE' | 'BLOCKED'
  password_hash VARCHAR(255) NOT NULL
);
```

#### 3. `requirements` (Transport Auction Loads)
```sql
CREATE TABLE IF NOT EXISTS requirements (
  id VARCHAR(255) PRIMARY KEY,          -- Format: TR-2026-0001
  pickup_location VARCHAR(255) NOT NULL,
  delivery_location VARCHAR(255) NOT NULL,
  material VARCHAR(255) NOT NULL,
  weight NUMERIC NOT NULL,              -- Weight in Metric Tons
  vehicle_type VARCHAR(255) NOT NULL,
  number_of_vehicles INTEGER NOT NULL DEFAULT 1,
  pickup_date VARCHAR(50) NOT NULL,     -- YYYY-MM-DD
  expected_delivery VARCHAR(50),
  special_instructions TEXT,
  documents TEXT[] NOT NULL DEFAULT '{}',
  bid_opening_time VARCHAR(50) NOT NULL,
  bid_closing_time VARCHAR(50) NOT NULL, -- ISO timestamp
  target_rate NUMERIC,                  -- Target price in INR
  award_type VARCHAR(50) NOT NULL,      -- 'MANUAL' | 'AUTOMATIC'
  status VARCHAR(50) NOT NULL,          -- 'DRAFT' | 'LIVE' | 'CLOSED' | 'AWARDED' | 'CANCELLED' | 'TIE_RESOLUTION_REQUIRED' | 'active' | 'published'
  created_at VARCHAR(50) NOT NULL,
  targeted_transporter_ids TEXT[]       -- Restricts load to specific transporter IDs (if empty, open to all matching vehicle types)
);
```

#### 4. `requirement_invitations` (Load Access Control)
```sql
CREATE TABLE IF NOT EXISTS requirement_invitations (
  id VARCHAR(255) PRIMARY KEY,          -- Format: inv_<hash>
  requirement_id VARCHAR(255) NOT NULL,
  transporter_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,          -- 'INVITED' | 'REMOVED'
  removed_reason TEXT
);
```

#### 5. `bids` (Current Active Transporter Bids)
```sql
CREATE TABLE IF NOT EXISTS bids (
  id VARCHAR(255) PRIMARY KEY,          -- Format: bid_<hash>
  requirement_id VARCHAR(255) NOT NULL,
  transporter_id VARCHAR(255) NOT NULL,
  amount NUMERIC NOT NULL,              -- Rate quotation in INR
  timestamp VARCHAR(50) NOT NULL,
  last_updated VARCHAR(50) NOT NULL,
  UNIQUE(requirement_id, transporter_id)
);
```

#### 6. `bid_history` (Audit Log of Every Quotation Change)
```sql
CREATE TABLE IF NOT EXISTS bid_history (
  id VARCHAR(255) PRIMARY KEY,          -- Format: bh_<hash>
  requirement_id VARCHAR(255) NOT NULL,
  transporter_id VARCHAR(255) NOT NULL,
  amount NUMERIC NOT NULL,
  timestamp VARCHAR(50) NOT NULL
);
```

#### 7. `awards` (Contract Award Records)
```sql
CREATE TABLE IF NOT EXISTS awards (
  id VARCHAR(255) PRIMARY KEY,          -- Format: award_<hash>
  requirement_id VARCHAR(255) NOT NULL,
  transporter_id VARCHAR(255) NOT NULL,
  amount NUMERIC NOT NULL,
  awarded_at VARCHAR(50) NOT NULL,
  awarded_by VARCHAR(255) NOT NULL,     -- User ID or 'SYSTEM_AUTO'
  tie_break_log TEXT                    -- Written justification if awarded from tied L1 bids
);
```

#### 8. `sessions` (Device Session Management)
```sql
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(255) PRIMARY KEY,          -- Format: sess_<hash>
  transporter_id VARCHAR(255),
  user_id VARCHAR(255),
  user_role VARCHAR(50) NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  browser VARCHAR(255),
  os VARCHAR(255),
  ip_address VARCHAR(255),
  login_time VARCHAR(50) NOT NULL,
  last_activity VARCHAR(50) NOT NULL,
  refresh_token VARCHAR(500) NOT NULL,
  expiry VARCHAR(50) NOT NULL
);
```

#### 9. `audit_logs` (System Security & Change Auditing)
```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(255) PRIMARY KEY,          -- Format: audit_<hash>
  user_id VARCHAR(255),
  user_email VARCHAR(255),
  role VARCHAR(50),
  action VARCHAR(255) NOT NULL,
  timestamp VARCHAR(50) NOT NULL,
  ip_address VARCHAR(255),
  device TEXT,
  old_value TEXT,
  new_value TEXT
);
```

#### 10. `notification_provider_configs` & Dispatch Logs
```sql
CREATE TABLE IF NOT EXISTS notification_provider_configs (
  id VARCHAR(255) PRIMARY KEY,          -- Fixed ID: 'default'
  whatsapp_waba_id VARCHAR(255),
  whatsapp_phone_id VARCHAR(255),
  whatsapp_token TEXT,
  whatsapp_verify_token VARCHAR(255),
  whatsapp_status VARCHAR(50),
  whatsapp_error TEXT,
  sms_provider VARCHAR(50),             -- 'twilio' | 'msg91' | 'mock'
  sms_api_key VARCHAR(255),
  sms_auth_token TEXT,
  sms_sender_id VARCHAR(255),
  sms_status VARCHAR(50),
  sms_error TEXT,
  email_provider VARCHAR(50),           -- 'resend' | 'mock'
  email_api_key TEXT,
  email_sender_address VARCHAR(255),
  email_status VARCHAR(50),
  email_error TEXT
);

CREATE TABLE IF NOT EXISTS sms_logs (
  id VARCHAR(255) PRIMARY KEY,
  "to" VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  sent_at VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  error TEXT,
  provider VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS email_logs (
  id VARCHAR(255) PRIMARY KEY,
  "to" VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  sent_at VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  error TEXT,
  provider VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id VARCHAR(255) PRIMARY KEY,
  "to" VARCHAR(255) NOT NULL,
  template VARCHAR(255) NOT NULL,
  params JSONB,
  sent_at VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  error TEXT,
  provider VARCHAR(50) NOT NULL
);
```

---

## 4. Core Business Logic & Algorithms

### 4.1 Reverse Auction Ranking Algorithm (1-2-2-4 Standard Competition Ranking)

In reverse logistics auctions, lower price quotations are better.
- **L1 (Level 1):** The lowest bid rate.
- **Tied Bids:** Transporters submitting identical rates share the same rank.
- **Formula:** `Rank of Bid B = 1 + (Number of active bids strictly lower than B.amount)`.

#### Ranking Calculation Logic:
```typescript
export async function calculateRanks(requirementId: string): Promise<TransporterRank[]> {
  // 1. Fetch requirement and all invited + bidding transporters
  // 2. Filter submitted bids and sort ascending by amount
  // 3. For each bid, calculate rank = 1 + count of bids strictly cheaper
  // 4. Mark isL1 = (rank === 1)
  // 5. Merge unsubmitted invited transporters as 'PENDING' rank
  // 6. Return sorted list (Bids by rank, unsubmitted alphabetically)
}
```

#### Example Ranking Matrix:

| Transporter | Bid Amount | Calculated Rank | Status |
| :--- | :--- | :--- | :--- |
| FastCargo Logistics | ₹42,000 | **Rank 1 (L1)** | Active |
| FleetExpress Pvt Ltd | ₹42,000 | **Rank 1 (L1 - Tied)** | Active |
| BlueDart Connect | ₹44,500 | **Rank 3** | Active |
| VRL Logistics | Unsubmitted | `null` | Pending |

### 4.2 Confidentiality & Anonymity Enforcement Matrix

Confidentiality is strictly enforced at the backend middleware level:

| User Role | View Competitor Names? | View Competitor Rates? | View Overall Bid History? | View Own Rank & L1 Status? |
| :--- | :---: | :---: | :---: | :---: |
| **SUPER_ADMIN** | YES | YES | YES | YES |
| **LOGISTICS** | YES | YES | YES | YES |
| **TRANSPORTER** | **NO** | **NO** | **NO** | **YES** (Own rank only) |

> **Security Rule:** When a Transporter requests `/api/requirements/:id/ranks`, the response payload is sanitized to ONLY return an array containing their own bid details and a boolean `l1Tied: boolean` flag. All competitor names, IDs, and rates are scrubbed before sending the response.

### 4.3 Bid Reduction Rule (Strict Anti-Inflation Enforcement)

To prevent market manipulation, transporters are strictly prohibited from increasing their bid price during an active auction round.
- **Validation Rule:** `newBidAmount < existingBidAmount`
- If `newBidAmount >= existingBidAmount`, backend rejects with status `400 Bad Request`:
  > *"Bid Reduction Rule: You can only submit a lower quotation than your previous rate of ₹X"*

### 4.4 Automated Closing & Award Engine

A background interval runner operates every 10 seconds checking all `LIVE` requirements against `bidClosingTime`:

```mermaid
flowchart TD
    Start([10s Cron Timer Fired]) --> FetchLive[Fetch Requirements where status = 'LIVE']
    FetchLive --> CheckTime{Now >= bidClosingTime?}
    CheckTime -- No --> End([Wait for next tick])
    CheckTime -- Yes --> CalcRanks[Calculate Ranks & Find L1 Bids]
    
    CalcRanks --> CheckAwardType{awardType?}
    
    CheckAwardType -- MANUAL --> MarkClosed[Set Status = 'CLOSED'] --> End
    
    CheckAwardType -- AUTOMATIC --> CheckL1Count{Count of L1 Bids}
    
    CheckL1Count -- 0 (No Bids) --> MarkClosed
    
    CheckL1Count -- 1 (Single L1) --> AwardWinner[Set Status = 'AWARDED'\nCreate Award Record\nNotify Winner & Losers via SMS/Email] --> End
    
    CheckL1Count -- >1 (Tied L1) --> FlagTie[Set Status = 'TIE_RESOLUTION_REQUIRED'\nLog Audit Warning\nNotify Logistics Staff to manually break tie] --> End
```

---

## 5. Security & Authentication Architecture

### 5.1 Dual-Token JWT & Cookie Lifecycle
FleexBid uses a dual JWT authentication model with sliding session refresh:
- **Access Token:** Short-lived JWT (15 minutes). Signed with `JWT_SECRET`. Carries `{ id, email, role, name }`. Sent via `Authorization: Bearer <token>` header or `accessToken` HTTP-only cookie.
- **Refresh Token:** Long-lived JWT (90 days). Carries `{ id, role, deviceId }`. Stored in secure HTTP-only cookie `refreshToken` and local storage.
- **Session Revocation:** Every token refresh verifies the active session against the `sessions` table by `deviceId`. If an admin blocks a user or revokes a session, the database deletes session records, instantly invalidating access.

### 5.2 Stateless In-Memory Auth Cache
To handle high-concurrency bidding without hammering database read queries, the backend uses a stateless in-memory cache (`authCache` Map):
- **TTL:** 15 seconds.
- **Invalidation:** Automatically cleared on any database write via `onDBWrite()` hook.

### 5.3 Role-Based Access Control (RBAC) & Spectator Mode

1. **`SUPER_ADMIN` (Master Admin):**
   - Unrestricted CRUD on Staff, Transporters, Requirements, System Settings, Audit Logs.
   - Exclusive right to permanently delete records (`DELETE /api/v1/admin/*`).
2. **`LOGISTICS` (Logistics Manager):**
   - Create, edit, publish, extend, cancel, and award requirements.
   - Onboard and manage transporters.
   - Read-only access to staff list.
3. **`TRANSPORTER` (Carrier Partner):**
   - Restricted to viewing invited/public loads and submitting/reducing bid rates.
4. **Spectator Mode (`APPROVED` Staff Status):**
   - Staff accounts with status `'APPROVED'` (not yet marked `'AUTHORIZED'`) can log in and view pages, but all state-modifying HTTP methods (`POST`, `PUT`, `DELETE`, `PATCH`) are blocked with `403 Forbidden: Spectator Mode`.

---

## 6. Artificial Intelligence & Copilot Engine

FleexBid embeds Google Gemini AI (`@google/genai` library utilizing `gemini-3.5-flash`) for real-time logistics intelligence.

```
                  +-----------------------------------+
                  |        Client AI Advisor          |
                  +-----------------+-----------------+
                                    |
            +-----------------------+-----------------------+
            |                       |                       |
            v                       v                       v
   /api/ai/predict-rate  /api/ai/match-transporters  /api/ai/negotiator
            |                       |                       |
            +-----------------------+-----------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |    Google Gemini 3.5 Flash Model  |
                  |     (Structured JSON Schema)      |
                  +-----------------------------------+
```

### 6.1 AI Feature Modules

1. **Copilot Logistics Chat Assistant (`POST /api/ai/chat`):**
   - Ingests real-time platform statistics (active transporter counts, live requirements, total estimated savings achieved).
   - Serves as an interactive advisor for route planning, market trends, and procurement strategies.

2. **Market Rate Predictor (`POST /api/ai/predict-rate`):**
   - Takes: `pickup`, `delivery`, `vehicleType`, `weight`, `material`.
   - Returns Structured JSON:
     - `predictedMinRate` (INR)
     - `predictedMaxRate` (INR)
     - `recommendedTargetRate` (INR)
     - `confidenceScore` (0-100%)
     - `marketFactors` (Array of key drivers: diesel prices, toll surges, seasonal demand)
     - `routeDifficulty` & `strategicAdvice`.

3. **Smart Transporter Matching (`POST /api/ai/match-transporters`):**
   - Takes: `requirementId`.
   - Evaluates active transporters based on preferred routes, operating states, and fleet capabilities.
   - Returns Structured JSON: Array of matches with `matchScore` (0-100%), `matchReasons`, `riskFactors`, and a personalized outreach message draft.

4. **Supplier Negotiator (`POST /api/ai/negotiator`):**
   - Takes: `requirementId`.
   - Analyzes active bid rankings against target rates.
   - Generates custom counter-offer strategies and drafted messages for L1 volume discounts, L2/L3 target matching.

---

## 7. Multi-Channel Notification Subsystem

Notifications maintain high engagement during fast-paced reverse auctions.

### 7.1 Delivery Channels

1. **SMS Gateway:**
   - Provider: Twilio REST API (`https://api.twilio.com/2010-04-01/Accounts/...`) with fallback to Mock logger.
   - Triggers: OTP logins, new load published, contract awarded.
2. **Email Gateway:**
   - Provider: Nodemailer (SMTP transport / Ethereal auto-test account) or Mock.
   - Triggers: Requirement invitations, award notifications, outbid notifications.
3. **WhatsApp Business API:**
   - Template dispatch log tracking for commercial messaging.

---

## 8. Complete API Reference

### 8.1 Authentication Endpoints

| Method | Path | Auth | Roles | Description |
| :--- | :--- | :---: | :--- | :--- |
| `POST` | `/api/auth/login-staff` | None | All | Email + Password login for Corporate Staff |
| `POST` | `/api/auth/login-transporter` | None | All | Email + Password login for Transporters |
| `POST` | `/api/auth/refresh` | Token | All | Silent access token refresh using rotating refresh token |
| `POST` | `/api/auth/logout` | Token | All | Revokes active session for current device |
| `GET` | `/api/auth/me` | Token | All | Returns current active user object |

### 8.2 Transport Requirements Endpoints

| Method | Path | Auth | Roles | Description |
| :--- | :--- | :---: | :--- | :--- |
| `GET` | `/api/requirements` | Token | All | List requirements (Transporters only see invited/public loads) |
| `GET` | `/api/requirements/:id` | Token | All | Get detailed requirement by ID |
| `POST` | `/api/requirements` | Token | Staff | Create new draft requirement(s) |
| `PUT` | `/api/requirements/:id` | Token | Staff | Update draft requirement details |
| `PUT` | `/api/requirements/:id/publish` | Token | Staff | Publish requirement to `LIVE` and notify carriers |
| `PUT` | `/api/requirements/:id/cancel` | Token | Staff | Cancel requirement auction |
| `PUT` | `/api/requirements/:id/extend` | Token | Staff | Extend auction closing time |
| `PUT` | `/api/requirements/:id/invitations` | Token | Staff | Update invited carriers mid-round (requires audit reason) |
| `POST` | `/api/v1/requirements` | Token | Staff | V1 endpoint to create/publish active load requirements |

### 8.3 Bidding & Awarding Endpoints

| Method | Path | Auth | Roles | Description |
| :--- | :--- | :---: | :--- | :--- |
| `GET` | `/api/requirements/:id/ranks` | Token | All | Fetch live ranking (Confidential view for Transporters) |
| `POST` | `/api/requirements/:id/bid` | Token | Transporter | Submit or reduce bid quotation rate |
| `POST` | `/api/v1/bids` | Token | Transporter | V1 Submit bid quotation rate |
| `PUT` | `/api/v1/bids/:id` | Token | Transporter | V1 Update bid quotation rate |
| `POST` | `/api/requirements/:id/award` | Token | Staff | Award contract to transporter (Resolves ties) |

### 8.4 User & Transporter Management Endpoints

| Method | Path | Auth | Roles | Description |
| :--- | :--- | :---: | :--- | :--- |
| `GET` | `/api/transporters` | Token | Staff | Fetch list of onboarded transporters |
| `POST` | `/api/transporters` | Token | Staff | Onboard a new transporter company |
| `PUT` | `/api/transporters/:id` | Token | Staff | Update transporter details / status |
| `GET` | `/api/staff` | Token | Super Admin | Fetch list of corporate staff members |
| `POST` | `/api/staff` | Token | Super Admin | Onboard a new staff member |
| `PUT` | `/api/staff/:id` | Token | Super Admin | Update staff account details / role / status |

### 8.5 Admin Maintenance & Destruction Endpoints (Super Admin Only)

| Method | Path | Auth | Roles | Description |
| :--- | :--- | :---: | :--- | :--- |
| `DELETE` | `/api/v1/admin/staff/:id` | Token | Super Admin | Permanently delete staff account |
| `DELETE` | `/api/v1/admin/transporters/:id` | Token | Super Admin | Permanently delete transporter account & linked bids |
| `DELETE` | `/api/v1/admin/requirements/:id` | Token | Super Admin | Permanently delete requirement auction & linked bids |

### 8.6 System Settings, Logs & AI Endpoints

| Method | Path | Auth | Roles | Description |
| :--- | :--- | :---: | :--- | :--- |
| `GET` | `/api/settings/notifications` | Token | Super Admin | Fetch notification provider credentials (masked) |
| `PUT` | `/api/settings/notifications` | Token | Super Admin | Update notification provider credentials |
| `POST` | `/api/settings/notifications/test` | Token | Super Admin | Test live connection to SMS/Email providers |
| `GET` | `/api/logs/notifications` | Token | Staff | Fetch notification dispatch history |
| `GET` | `/api/logs/audit` | Token | Staff | Fetch system security audit logs |
| `GET` | `/api/sessions` | Token | All | Fetch active login sessions for current user |
| `DELETE` | `/api/sessions/:id` | Token | All | Revoke session for specific device ID |
| `POST` | `/api/ai/chat` | Token | All | Gemini Copilot chat assistant |
| `POST` | `/api/ai/predict-rate` | Token | All | Gemini rate prediction endpoint |
| `POST` | `/api/ai/match-transporters` | Token | Staff | Gemini smart transporter matching |
| `POST` | `/api/ai/negotiator` | Token | Staff | Gemini supplier negotiator strategies |

---

## 9. Frontend Application Architecture & UI Guide

### 9.1 Route Tree & Navigation Matrix

```
/ (Root)
├── /login              --> Login Screen (Staff & Transporter Login Modes)
├── /dashboard          --> Analytics Dashboard (KPI Cards, Volume Charts, Quick Actions)
├── /requirements       --> Bidding Auctions List (Filters, Status Tabs, Create Requirement Modal)
├── /bid/:id            --> Live Auction Console (Real-time Socket Bidding, Ranks Table, AI Rates)
├── /ai-advisor         --> AI Logistics Center (Rate Predictor, Transporter Matcher, AI Chat)
├── /transporters       --> Transporter Directory & Onboarding Form (Staff Only)
└── /staff              --> Staff Management & User Role Permissions (Super Admin Only)
```

### 9.2 Page Breakdown & Features

#### 1. Dashboard Page (`src/pages/Dashboard.tsx`)
- **Key Metrics:** Active Auctions Count, Procured Requirements, Estimated Savings (INR), Active Transporters Count.
- **Visual Analytics:** Interactive charts for requirement status breakdown, monthly volume trends, and savings metrics.
- **Quick Action Triggers:** Create New Requirement Modal, AI Rate Prediction Drawer.

#### 2. Requirements List (`src/pages/RequirementsList.tsx`)
- **Status Filtering:** Tabs for `ALL`, `DRAFT`, `LIVE`, `CLOSED`, `AWARDED`, `TIE_RESOLUTION_REQUIRED`.
- **Search & Filter:** Search by Requirement ID (`TR-2026-XXXX`), Pickup/Delivery Location, or Material.
- **Create Requirement Modal:** Form supporting single and bulk creation of transport requirements with vehicle type picker, weight input, target rate, bid closing time, and target carrier assignment.

#### 3. Auction Detail Console (`src/pages/RequirementDetail.tsx`)
- **Real-Time Header:** Live status pill, countdown timer to `bidClosingTime`, pickup/delivery route map summary.
- **Transporter View:**
  - Big rate submission widget with validation (must be lower than previous quotation).
  - Personal status display showing current rate, current rank (L1 indicator), and auction state.
- **Staff / Admin View:**
  - Complete live rankings table listing all participating transporters, their bid amounts, submission timestamps, and tie statuses.
  - Manual award controls with required justification field for resolving L1 ties.
  - Mid-round carrier invitation editor with required exclusion reason logging.
- **Socket Integration:** Listens to `rank_updated` and `requirement_updated` socket events to refresh rank tables instantly without manual page refreshes.

#### 4. AI Advisor (`src/pages/AiAdvisor.tsx`)
- **Tab 1 — AI Rate Predictor:** Form accepting route inputs (`pickup`, `delivery`, `vehicleType`, `weight`). Returns predicted price range, confidence percentage, market risk factors, and recommended target rate.
- **Tab 2 — Smart Fleet Matcher:** Selects an existing requirement and returns AI-ranked transporter recommendations with match scores and pre-drafted WhatsApp/email outreach copy.
- **Tab 3 — Supplier Negotiator:** Generates tailored counter-offer strategies and draft messages for L1 volume discounts and L2 rate matching.
- **Tab 4 — FleexBid Copilot Chat:** Interactive conversational interface for general logistics advice.

#### 5. Transporter Onboarding (`src/pages/OnboardTransporters.tsx`)
- Onboarding form capturing: Company Name, Contact Person, Email, Mobile Number, GSTIN, PAN, Vehicle Types (multi-select), Operating States, Preferred Routes, and Initial Password.
- Directory table with status toggles (`ACTIVE`, `INACTIVE`, `BLOCKED`) and password update dialogs.

#### 6. Staff Management (`src/pages/StaffManagement.tsx`)
- Corporate user management console restricted to `SUPER_ADMIN`.
- Allows creating/editing staff members, switching roles (`SUPER_ADMIN` vs `LOGISTICS`), and updating statuses (`AUTHORIZED`, `APPROVED`, `BLOCKED`).

---

## 10. Installation, Deployment & Environment Configuration

### 10.1 Environment Variables Setup

Create a `.env` file in the root directory:

```env
# Server & Runtime Configuration
NODE_ENV=production
PORT=3000
APP_URL=https://fleexbid.vercel.app

# Database Configuration (PostgreSQL / Neon Postgres)
DATABASE_URL=postgresql://user:password@ep-example-123456.us-east-2.aws.neon.tech/fleexbid?sslmode=require

# Security & Authentication Secrets
JWT_SECRET=your_super_secret_cryptographic_jwt_key_2026

# Google Gemini AI Integration
GEMINI_API_KEY=your_google_gemini_api_key

# Optional Notification Provider Credentials
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+1234567890
```

### 10.2 Installation & Startup Instructions

#### Step 1: Install Dependencies
```bash
npm install
```

#### Step 2: Running in Development Mode
Starts the Express server wrapped with Vite middleware and hot-reloading:
```bash
npm run dev
```

#### Step 3: Production Build & Execution
Builds the client single-page app and bundles `app.ts` into a single Node.js CJS executable:
```bash
npm run build
npm start
```

#### Step 4: Database Auto-Initialization
On server launch, `initDatabase()` automatically connects to PostgreSQL, creates all required tables if missing, adds required indexes, and seeds default initial accounts:
- **Default Master Admin:** `aronkumar.logistics@gmail.com` / `admin123`

---

## 11. Complete Verification & Testing Strategy

To verify an end-to-end deployment of FleexBid, execute the following test plan:

### 1. Authentication & RBAC Verification
- [ ] Log in as Master Admin (`aronkumar.logistics@gmail.com`). Verify access to Staff Management (`/staff`).
- [ ] Create a new Logistics Staff member with status `'APPROVED'` (Spectator Mode). Log in with that account and verify that trying to create a requirement returns `403 Spectator Mode`.
- [ ] Upgrade staff status to `'AUTHORIZED'`. Verify requirement creation succeeds.

### 2. Reverse Auction & Confidentiality Verification
- [ ] Create a requirement (`TR-2026-0001`) with `awardType = 'MANUAL'`.
- [ ] Log in as Transporter A (`tr1`). Submit a bid of ₹50,000. Verify Transporter A sees Rank 1 (L1).
- [ ] Attempt to submit a bid of ₹52,000 as Transporter A. Verify backend rejects with Bid Reduction Rule error `400`.
- [ ] Submit a bid of ₹48,000 as Transporter A. Verify bid updates successfully.
- [ ] Log in as Transporter B (`tr2`). Submit a bid of ₹45,000. Verify Transporter B becomes Rank 1 (L1), and Transporter A's view updates to Rank 2 via WebSocket.
- [ ] Verify Transporter B CANNOT see Transporter A's name, email, or rate.

### 3. Automated Award & Tie-Break Verification
- [ ] Create a requirement with `awardType = 'AUTOMATIC'` and set `bidClosingTime` 30 seconds in the future.
- [ ] Submit identical rates of ₹40,000 from both Transporter A and Transporter B.
- [ ] Wait 30 seconds for the background cron to run. Verify requirement status updates to `TIE_RESOLUTION_REQUIRED`.
- [ ] Log in as Staff. Open auction detail, provide a written tie-break justification note, and manually award the contract to Transporter A. Verify requirement status becomes `AWARDED`.

### 4. AI Advisor Verification
- [ ] Open `/ai-advisor`. Navigate to Rate Predictor. Enter route `Mumbai -> Delhi` for `32ft MXL` vehicle. Verify structured rate range and confidence score are returned.
- [ ] Test the AI Copilot Chat assistant. Send a query regarding current market freight rates. Verify intelligent response incorporating live platform statistics.

---

## 12. Summary Checklist for Scratch Implementation

If you are recreating this app from scratch, ensure you implement:
1. **Express Server & Socket.io Integration:** Wrap Express with HTTP server and Socket.io namespace `req_<requirementId>`.
2. **PostgreSQL Connection Pool:** Implement `pg.Pool` with column key normalizer (`snake_case` <-> `camelCase`).
3. **1-2-2-4 Competition Ranking:** Calculate ranks dynamically using strict lower-count formula.
4. **Confidential Response Sanitizer:** Scrub competitor details from Transporter API responses.
5. **Bid Reduction Validation:** Reject higher bids on active requirements.
6. **Auto-Close Background Cron:** `setInterval` running every 10 seconds evaluating `LIVE` requirements.
7. **Gemini 3.5 Flash JSON Schemas:** Use `responseSchema` for structured rate predictions and matching.
8. **React Router Protect Guards:** Wrap `/transporters` and `/staff` routes with role checks.
9. **Tailwind CSS v4 Styling:** Modern responsive dark/light UI design system.

---
*End of Specifications Document.*
