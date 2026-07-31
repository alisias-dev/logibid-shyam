-- DATABASE MIGRATION: TARGET-ORIENTED INDEXES FOR HIGH-FREQUENCY LOOKUPS
-- Optimized for 1,000 active concurrent users running real-time bidding operations

-- 1. Index on users.email for rapid login lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- 2. Index on users.role and users.status for filtering authorized dashboard access and RBAC validations
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, status);

-- 3. Composite index on bids(requirement_id, transporter_id) to speed up live bidding tables and duplicate bid checks
CREATE INDEX IF NOT EXISTS idx_bids_requirement_transporter ON bids (requirement_id, transporter_id);

-- 4. Index on requirements.status for instant fetching of open/live loads
CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements (status);
