import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { queryPool } from './db_pool';
import { 
  User, 
  Transporter, 
  Requirement, 
  RequirementInvitation, 
  Bid, 
  BidHistory, 
  Award, 
  NotificationProviderConfig, 
  AuditLog, 
  Session,
  EmailOtpVerification
} from '../src/types';

interface DatabaseSchema {
  users: User[];
  transporters: Transporter[];
  requirements: Requirement[];
  requirementInvitations: RequirementInvitation[];
  bids: Bid[];
  bidHistory: BidHistory[];
  awards: Award[];
  notificationProviderConfigs: NotificationProviderConfig[];
  auditLogs: AuditLog[];
  sessions: Session[];
  emailOtpVerifications: EmailOtpVerification[];
}

/**
 * Generate secure UUID
 */
export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export const dbWriteListeners: (() => void)[] = [];

export function onDBWrite(listener: () => void) {
  dbWriteListeners.push(listener);
}

export function triggerDBWrite() {
  for (const listener of dbWriteListeners) {
    try {
      listener();
    } catch (err) {
      console.error('Error in db write listener:', err);
    }
  }
}

/**
 * Helper to convert camelCase string to snake_case
 */
function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Retrieves the full database schema snapshot from PostgreSQL.
 */
export async function getDB(): Promise<DatabaseSchema> {
  const [
    users,
    transporters,
    requirements,
    requirementInvitations,
    bids,
    bidHistory,
    awards,
    notificationProviderConfigs,
    auditLogs,
    sessions,
    emailOtpVerifications,
    smsLogs,
    emailLogs,
    whatsAppLogs
  ] = await Promise.all([
    queryPool('SELECT * FROM users'),
    queryPool('SELECT * FROM transporters'),
    queryPool('SELECT * FROM requirements'),
    queryPool('SELECT * FROM requirement_invitations'),
    queryPool('SELECT * FROM bids'),
    queryPool('SELECT * FROM bid_history'),
    queryPool('SELECT * FROM awards'),
    queryPool('SELECT * FROM notification_provider_configs'),
    queryPool('SELECT * FROM audit_logs'),
    queryPool('SELECT * FROM sessions'),
    queryPool('SELECT * FROM email_otp_verifications'),
    queryPool('SELECT * FROM sms_logs').catch(() => ({ rows: [] })),
    queryPool('SELECT * FROM email_logs').catch(() => ({ rows: [] })),
    queryPool('SELECT * FROM whatsapp_logs').catch(() => ({ rows: [] }))
  ]);

  const transportersRows = transporters.rows.map(t => ({
    ...t,
    vehicleTypes: t.vehicleTypes || [],
    operatingStates: t.operatingStates || [],
    preferredRoutes: t.preferredRoutes || []
  }));

  const requirementsRows = requirements.rows.map(r => ({
    ...r,
    weight: r.weight ? Number(r.weight) : 0,
    targetRate: r.targetRate ? Number(r.targetRate) : null,
    documents: r.documents || [],
    targeted_transporter_ids: r.targetedTransporterIds || [],
    targetedTransporterIds: r.targetedTransporterIds || []
  }));

  const bidsRows = bids.rows.map(b => ({
    ...b,
    amount: Number(b.amount)
  }));

  const bidHistoryRows = bidHistory.rows.map(bh => ({
    ...bh,
    amount: Number(bh.amount)
  }));

  const awardsRows = awards.rows.map(a => ({
    ...a,
    amount: Number(a.amount)
  }));

  const db: any = {
    users: users.rows,
    transporters: transportersRows,
    requirements: requirementsRows,
    requirementInvitations: requirementInvitations.rows,
    bids: bidsRows,
    bidHistory: bidHistoryRows,
    awards: awardsRows,
    notificationProviderConfigs: notificationProviderConfigs.rows,
    auditLogs: auditLogs.rows,
    sessions: sessions.rows,
    emailOtpVerifications: emailOtpVerifications.rows,
    smsLogs: smsLogs.rows,
    emailLogs: emailLogs.rows,
    whatsAppLogs: whatsAppLogs.rows.map((wl: any) => ({
      ...wl,
      params: typeof wl.params === 'string' ? JSON.parse(wl.params) : wl.params
    }))
  };

  return db;
}

/**
 * generic diff-sync function for tables mapping columns to database snake_case
 */
async function syncTable(
  tableName: string,
  initialRows: any[],
  updatedRows: any[],
  columns: string[]
) {
  const initialMap = new Map(initialRows.map(r => [r.id, r]));
  const updatedMap = new Map(updatedRows.map(r => [r.id, r]));

  // 1. Delete rows not present in updated snapshot
  for (const row of initialRows) {
    if (!updatedMap.has(row.id)) {
      await queryPool(`DELETE FROM ${tableName} WHERE id = $1`, [row.id]);
    }
  }

  // 2. Insert new rows or update changed rows
  for (const row of updatedRows) {
    const initialRow = initialMap.get(row.id);
    
    const getVal = (col: string) => {
      return row[col];
    };

    if (!initialRow) {
      // Insert new row
      const vals = columns.map(getVal);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const snakeCols = columns.map(toSnakeCase).map(c => `"${c}"`).join(', ');
      await queryPool(`INSERT INTO ${tableName} (${snakeCols}) VALUES (${placeholders})`, vals);
    } else {
      // Check if diff exists
      let hasDiff = false;
      for (const col of columns) {
        let val1 = initialRow[col];
        let val2 = row[col];

        if (JSON.stringify(val1) !== JSON.stringify(val2)) {
          hasDiff = true;
          break;
        }
      }

      if (hasDiff) {
        // Update changed row
        const vals = columns.filter(c => c !== 'id').map(getVal);
        vals.push(row.id);

        const setClause = columns
          .filter(c => c !== 'id')
          .map((c, i) => `"${toSnakeCase(c)}" = $${i + 1}`)
          .join(', ');

        await queryPool(`UPDATE ${tableName} SET ${setClause} WHERE id = $${columns.length}`, vals);
      }
    }
  }
}

/**
 * Runs updater on PostgreSQL state by performing snapshot diffing.
 * Executes parameterized queries against pg.Pool.
 */
export async function writeDB(updater: (db: DatabaseSchema) => void | Promise<void>): Promise<void> {
  const db = await getDB();
  const initial = JSON.parse(JSON.stringify(db));

  await updater(db);

  await syncTable('users', initial.users, db.users, ['id', 'email', 'passwordHash', 'role', 'name', 'status']);
  
  await syncTable('transporters', initial.transporters, db.transporters, [
    'id', 'companyName', 'contactPerson', 'email', 'mobileNumber', 'gstNumber', 'panNumber', 'vehicleTypes', 'operatingStates', 'preferredRoutes', 'status', 'passwordHash'
  ]);
  
  await syncTable('requirements', initial.requirements, db.requirements, [
    'id', 'pickupLocation', 'deliveryLocation', 'material', 'weight', 'vehicleType', 'numberOfVehicles', 'pickupDate', 'expectedDelivery', 'specialInstructions', 'documents', 'bidOpeningTime', 'bidClosingTime', 'targetRate', 'awardType', 'status', 'createdAt', 'targetedTransporterIds'
  ]);
  
  await syncTable('requirement_invitations', initial.requirementInvitations, db.requirementInvitations, [
    'id', 'requirementId', 'transporterId', 'status', 'removedReason'
  ]);
  
  await syncTable('bids', initial.bids, db.bids, ['id', 'requirementId', 'transporterId', 'amount', 'timestamp', 'lastUpdated']);
  
  await syncTable('bid_history', initial.bidHistory, db.bidHistory, ['id', 'requirementId', 'transporterId', 'amount', 'timestamp']);
  
  await syncTable('awards', initial.awards, db.awards, ['id', 'requirementId', 'transporterId', 'amount', 'awardedAt', 'awardedBy', 'tieBreakLog']);
  
  await syncTable('notification_provider_configs', initial.notificationProviderConfigs, db.notificationProviderConfigs, [
    'id', 'whatsappWabaId', 'whatsappPhoneId', 'whatsappToken', 'whatsappVerifyToken', 'whatsappStatus', 'whatsappError',
    'smsProvider', 'smsApiKey', 'smsAuthToken', 'smsSenderId', 'smsStatus', 'smsError',
    'emailProvider', 'emailApiKey', 'emailSenderAddress', 'emailStatus', 'emailError'
  ]);
  
  await syncTable('audit_logs', initial.auditLogs, db.auditLogs, [
    'id', 'userId', 'userEmail', 'role', 'action', 'timestamp', 'ipAddress', 'device', 'oldValue', 'newValue'
  ]);

  triggerDBWrite();
}

/**
 * Auto-initialization sequence that safely applies structural tables and indexes in Neon PostgreSQL.
 * Uses standard snake_case without case-sensitive double quotes.
 */
export async function initDatabase() {
  console.log('Initializing PostgreSQL Database schema and seed data...');
  
  // 1. Create tables
  await queryPool(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS transporters (
      id VARCHAR(255) PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      mobile_number VARCHAR(50) NOT NULL,
      gst_number VARCHAR(50) NOT NULL,
      pan_number VARCHAR(50) NOT NULL,
      vehicle_types TEXT[] NOT NULL,
      operating_states TEXT[] NOT NULL,
      preferred_routes TEXT[] NOT NULL,
      status VARCHAR(50) NOT NULL,
      password_hash VARCHAR(255) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS requirements (
      id VARCHAR(255) PRIMARY KEY,
      pickup_location VARCHAR(255) NOT NULL,
      delivery_location VARCHAR(255) NOT NULL,
      material VARCHAR(255) NOT NULL,
      weight NUMERIC NOT NULL,
      vehicle_type VARCHAR(255) NOT NULL,
      number_of_vehicles INTEGER NOT NULL,
      pickup_date VARCHAR(50) NOT NULL,
      expected_delivery VARCHAR(50) NOT NULL,
      special_instructions TEXT,
      documents TEXT[] NOT NULL,
      bid_opening_time VARCHAR(50) NOT NULL,
      bid_closing_time VARCHAR(50) NOT NULL,
      target_rate NUMERIC,
      award_type VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      targeted_transporter_ids TEXT[]
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS requirement_invitations (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL,
      removed_reason TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS bids (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      amount NUMERIC NOT NULL,
      timestamp VARCHAR(50) NOT NULL,
      last_updated VARCHAR(50) NOT NULL,
      UNIQUE(requirement_id, transporter_id)
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS bid_history (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      amount NUMERIC NOT NULL,
      timestamp VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS awards (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      amount NUMERIC NOT NULL,
      awarded_at VARCHAR(50) NOT NULL,
      awarded_by VARCHAR(255) NOT NULL,
      tie_break_log TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS notification_provider_configs (
      id VARCHAR(255) PRIMARY KEY,
      whatsapp_waba_id VARCHAR(255),
      whatsapp_phone_id VARCHAR(255),
      whatsapp_token TEXT,
      whatsapp_verify_token VARCHAR(255),
      whatsapp_status VARCHAR(50) NOT NULL,
      whatsapp_error TEXT,
      sms_provider VARCHAR(50) NOT NULL,
      sms_api_key VARCHAR(255),
      sms_auth_token VARCHAR(255),
      sms_sender_id VARCHAR(255),
      sms_status VARCHAR(50) NOT NULL,
      sms_error TEXT,
      email_provider VARCHAR(50) NOT NULL,
      email_api_key VARCHAR(255),
      email_sender_address VARCHAR(255),
      email_status VARCHAR(50) NOT NULL,
      email_error TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255),
      user_email VARCHAR(255),
      role VARCHAR(50),
      action VARCHAR(255) NOT NULL,
      timestamp VARCHAR(50) NOT NULL,
      ip_address VARCHAR(50),
      device TEXT,
      old_value TEXT,
      new_value TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(255) PRIMARY KEY,
      transporter_id VARCHAR(255),
      user_id VARCHAR(255),
      user_role VARCHAR(50) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      browser TEXT NOT NULL,
      os TEXT NOT NULL,
      ip_address VARCHAR(50) NOT NULL,
      login_time VARCHAR(50) NOT NULL,
      last_activity VARCHAR(50) NOT NULL,
      refresh_token VARCHAR(255) NOT NULL,
      expiry VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS email_otp_verifications (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      hashed_otp VARCHAR(255) NOT NULL,
      expiry VARCHAR(50) NOT NULL,
      attempts INTEGER NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS sms_logs (
      id VARCHAR(255) PRIMARY KEY,
      "to" VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      sent_at VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      error TEXT,
      provider VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
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
  `);

  await queryPool(`
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
  `);

  // 2. Create indexes in standard unquoted snake_case
  await queryPool('CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, status);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_bids_requirement_transporter ON bids (requirement_id, transporter_id);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements (status);');

  // 3. Seed users if table is empty
  const userCheck = await queryPool('SELECT count(*) FROM users');
  if (parseInt(userCheck.rows[0].count, 10) === 0) {
    console.log('Seeding default users...');
    const adminHash = await bcrypt.hash('admin123', 10);
    const logisticsHash = await bcrypt.hash('logistics123', 10);
    const aronHash = await bcrypt.hash('aron2610', 10);

    await queryPool(`
      INSERT INTO users (id, email, password_hash, role, name, status) VALUES
      ($1, $2, $3, $4, $5, $6),
      ($7, $8, $9, $10, $11, $12),
      ($13, $14, $15, $16, $17, $18)
    `, [
      'usr_admin', 'admin@logibid.com', adminHash, 'SUPER_ADMIN', 'Super Admin User', 'ACTIVE',
      'usr_logistics', 'logistics@logibid.com', logisticsHash, 'LOGISTICS', 'Logistics Executive', 'ACTIVE',
      'usr_aron', 'aronkumar.logistics@gmail.com', aronHash, 'SUPER_ADMIN', 'Aron Kumar', 'ACTIVE'
    ]);
  } else {
    // Gracefully update aronkumar's credentials and parameters if missing
    console.log('Verifying primary Super Admin aronkumar.logistics@gmail.com credentials...');
    const aronCheck = await queryPool('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', ['aronkumar.logistics@gmail.com']);
    const aronHash = await bcrypt.hash('aron2610', 10);
    if (aronCheck.rows.length === 0) {
      await queryPool(`
        INSERT INTO users (id, email, password_hash, role, name, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['usr_aron', 'aronkumar.logistics@gmail.com', aronHash, 'SUPER_ADMIN', 'Aron Kumar', 'ACTIVE']);
    } else {
      const aronUser = aronCheck.rows[0];
      const isPassCorrect = await bcrypt.compare('aron2610', aronUser.passwordHash);
      if (!isPassCorrect || aronUser.role !== 'SUPER_ADMIN' || aronUser.status !== 'ACTIVE') {
        await queryPool(`
          UPDATE users SET password_hash = $1, role = $2, status = $3 WHERE id = $4
        `, [aronHash, 'SUPER_ADMIN', 'ACTIVE', aronUser.id]);
      }
    }
  }

  // 4. Seed transporters if table is empty
  const transCheck = await queryPool('SELECT count(*) FROM transporters');
  if (parseInt(transCheck.rows[0].count, 10) === 0) {
    console.log('Seeding default transporters...');
    const defaultTrHash = await bcrypt.hash('transporter123', 10);

    const defaultTransporters = [
      {
        id: 'tr_gati',
        companyName: 'Gati Transport',
        contactPerson: 'Ramesh Gati',
        email: 'gati@transport.com',
        mobileNumber: '+919876543210',
        gstNumber: '27AAAAA1111A1Z1',
        panNumber: 'AAAAA1111A',
        vehicleTypes: ['32 FT Trailer', '20 FT Container'],
        operatingStates: ['Maharashtra', 'Delhi', 'Haryana'],
        preferredRoutes: ['Mumbai -> Delhi', 'Delhi -> Jaipur'],
        status: 'ACTIVE',
        passwordHash: defaultTrHash
      },
      {
        id: 'tr_vrl',
        companyName: 'VRL Logistics',
        contactPerson: 'Vijay VRL',
        email: 'vrl@logistics.com',
        mobileNumber: '+919876543211',
        gstNumber: '29BBBBB2222B2Z2',
        panNumber: 'BBBBB2222B',
        vehicleTypes: ['32 FT Trailer', '19 FT Open Truck'],
        operatingStates: ['Karnataka', 'Tamil Nadu', 'Maharashtra'],
        preferredRoutes: ['Mumbai -> Delhi', 'Bangalore -> Chennai'],
        status: 'ACTIVE',
        passwordHash: defaultTrHash
      },
      {
        id: 'tr_tci',
        companyName: 'TCI Freight',
        contactPerson: 'Amit TCI',
        email: 'tci@freight.com',
        mobileNumber: '+919876543212',
        gstNumber: '27CCCCC3333C3Z3',
        panNumber: 'CCCCC3333C',
        vehicleTypes: ['32 FT Trailer', '40 FT Container'],
        operatingStates: ['Maharashtra', 'Delhi', 'Gujarat'],
        preferredRoutes: ['Mumbai -> Delhi'],
        status: 'ACTIVE',
        passwordHash: defaultTrHash
      },
      {
        id: 'tr_inactive',
        companyName: 'Express Cargo (Inactive)',
        contactPerson: 'John Cargo',
        email: 'john@expresscargo.com',
        mobileNumber: '+919876543213',
        gstNumber: '27DDDDD4444D4Z4',
        panNumber: 'DDDDD4444D',
        vehicleTypes: ['20 FT Container'],
        operatingStates: ['Maharashtra'],
        preferredRoutes: ['Mumbai -> Pune'],
        status: 'INACTIVE',
        passwordHash: defaultTrHash
      }
    ];

    for (const tr of defaultTransporters) {
      await queryPool(`
        INSERT INTO transporters (id, company_name, contact_person, email, mobile_number, gst_number, pan_number, vehicle_types, operating_states, preferred_routes, status, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        tr.id, tr.companyName, tr.contactPerson, tr.email, tr.mobileNumber, tr.gstNumber, tr.panNumber,
        tr.vehicleTypes, tr.operatingStates, tr.preferredRoutes, tr.status, tr.passwordHash
      ]);
    }
  }

  // 5. Seed default notification config if empty
  const configCheck = await queryPool('SELECT count(*) FROM notification_provider_configs');
  if (parseInt(configCheck.rows[0].count, 10) === 0) {
    console.log('Seeding default notification provider config...');
    await queryPool(`
      INSERT INTO notification_provider_configs (
        id, whatsapp_waba_id, whatsapp_phone_id, whatsapp_token, whatsapp_verify_token, whatsapp_status, whatsapp_error,
        sms_provider, sms_api_key, sms_auth_token, sms_sender_id, sms_status, sms_error,
        email_provider, email_api_key, email_sender_address, email_status, email_error
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
    `, [
      'default', '', '', '', 'verify_token_123', 'NOT_CONNECTED', null,
      'mock', '', '', '', 'NOT_CONNECTED', null,
      'mock', '', 'noreply@logibid.com', 'NOT_CONNECTED', null
    ]);
  }

  // 6. Seed sample requirements, invitations, and bids if empty
  const reqCheck = await queryPool('SELECT count(*) FROM requirements');
  if (parseInt(reqCheck.rows[0].count, 10) === 0) {
    console.log('Seeding default requirements, invitations, and bids...');
    const now = new Date();
    const closingTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const closedTime = new Date(now.getTime() - 10 * 60 * 1000);
    const draftTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const requirements = [
      {
        id: 'TR-2026-0001',
        pickupLocation: 'Mumbai',
        deliveryLocation: 'Delhi',
        material: 'Chemical Carboys',
        weight: 18,
        vehicleType: '32 FT Trailer',
        numberOfVehicles: 1,
        pickupDate: '2026-07-10',
        expectedDelivery: '2026-07-13',
        specialInstructions: 'Must carry valid MSDS and hazmat-trained driver.',
        documents: [],
        bidOpeningTime: now.toISOString(),
        bidClosingTime: closingTime.toISOString(),
        targetRate: 45000,
        awardType: 'MANUAL',
        status: 'LIVE',
        createdAt: now.toISOString(),
        targetedTransporterIds: []
      },
      {
        id: 'TR-2026-0002',
        pickupLocation: 'Bangalore',
        deliveryLocation: 'Chennai',
        material: 'Electronic Spares',
        weight: 10,
        vehicleType: '19 FT Open Truck',
        numberOfVehicles: 2,
        pickupDate: '2026-07-12',
        expectedDelivery: '2026-07-13',
        specialInstructions: 'Waterproof tarpaulin sheet is mandatory.',
        documents: [],
        bidOpeningTime: now.toISOString(),
        bidClosingTime: draftTime.toISOString(),
        targetRate: 22000,
        awardType: 'AUTOMATIC',
        status: 'DRAFT',
        createdAt: now.toISOString(),
        targetedTransporterIds: []
      },
      {
        id: 'TR-2026-0003',
        pickupLocation: 'Mumbai',
        deliveryLocation: 'Delhi',
        material: 'FMCG Goods',
        weight: 15,
        vehicleType: '32 FT Trailer',
        numberOfVehicles: 1,
        pickupDate: '2026-07-06',
        expectedDelivery: '2026-07-09',
        specialInstructions: 'No transshipment allowed.',
        documents: [],
        bidOpeningTime: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        bidClosingTime: closedTime.toISOString(),
        targetRate: 46000,
        awardType: 'AUTOMATIC',
        status: 'CLOSED',
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        targetedTransporterIds: []
      }
    ];

    for (const req of requirements) {
      await queryPool(`
        INSERT INTO requirements (id, pickup_location, delivery_location, material, weight, vehicle_type, number_of_vehicles, pickup_date, expected_delivery, special_instructions, documents, bid_opening_time, bid_closing_time, target_rate, award_type, status, created_at, targeted_transporter_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `, [
        req.id, req.pickupLocation, req.deliveryLocation, req.material, req.weight, req.vehicleType, req.numberOfVehicles,
        req.pickupDate, req.expectedDelivery, req.specialInstructions, req.documents, req.bidOpeningTime, req.bidClosingTime,
        req.targetRate, req.awardType, req.status, req.createdAt, req.targetedTransporterIds
      ]);
    }

    const invitations = [
      { id: 'inv_1', requirementId: 'TR-2026-0001', transporterId: 'tr_gati', status: 'INVITED', removedReason: null },
      { id: 'inv_2', requirementId: 'TR-2026-0001', transporterId: 'tr_vrl', status: 'INVITED', removedReason: null },
      { id: 'inv_3', requirementId: 'TR-2026-0001', transporterId: 'tr_tci', status: 'INVITED', removedReason: null },
      { id: 'inv_4', requirementId: 'TR-2026-0003', transporterId: 'tr_gati', status: 'INVITED', removedReason: null },
      { id: 'inv_5', requirementId: 'TR-2026-0003', transporterId: 'tr_vrl', status: 'INVITED', removedReason: null },
      { id: 'inv_6', requirementId: 'TR-2026-0003', transporterId: 'tr_tci', status: 'INVITED', removedReason: null }
    ];

    for (const inv of invitations) {
      await queryPool(`
        INSERT INTO requirement_invitations (id, requirement_id, transporter_id, status, removed_reason)
        VALUES ($1, $2, $3, $4, $5)
      `, [inv.id, inv.requirementId, inv.transporterId, inv.status, inv.removedReason]);
    }

    const bTime = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const bids = [
      { id: 'bid_1', requirementId: 'TR-2026-0003', transporterId: 'tr_gati', amount: 42000, timestamp: bTime, lastUpdated: bTime },
      { id: 'bid_2', requirementId: 'TR-2026-0003', transporterId: 'tr_vrl', amount: 42000, timestamp: bTime, lastUpdated: bTime },
      { id: 'bid_3', requirementId: 'TR-2026-0003', transporterId: 'tr_tci', amount: 45000, timestamp: bTime, lastUpdated: bTime }
    ];

    for (const bid of bids) {
      await queryPool(`
        INSERT INTO bids (id, requirement_id, transporter_id, amount, timestamp, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [bid.id, bid.requirementId, bid.transporterId, bid.amount, bid.timestamp, bid.lastUpdated]);

      await queryPool(`
        INSERT INTO bid_history (id, requirement_id, transporter_id, amount, timestamp)
        VALUES ($1, $2, $3, $4, $5)
      `, [`bh_${bid.id}`, bid.requirementId, bid.transporterId, bid.amount, bid.timestamp]);
    }
  }

  console.log('PostgreSQL database initialization successful.');
}
