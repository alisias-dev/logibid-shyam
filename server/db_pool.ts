import pg from 'pg';

let poolInstance: pg.Pool | null = null;

/**
 * Lazily initializes and retrieves the optimized PostgreSQL connection pool.
 * This prevents the application from crashing on startup if PostgreSQL config is not present.
 */
export function getDbPool(): pg.Pool {
  if (!poolInstance) {
    const connectionString = process.env.DATABASE_URL;
    const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
    
    // Fallback/mock support if no DATABASE_URL is configured yet
    if (!connectionString) {
      console.warn('DATABASE_URL env variable not detected. Initializing pg Pool with default/local parameters.');
    }

    const needsSsl = connectionString && (
      connectionString.includes('neon.tech') || 
      connectionString.includes('sslmode=require') || 
      isProduction
    );

    // Loud operational warning: a DIRECT Neon endpoint (no -pooler) means every
    // warm lambda holds up to `max` PHYSICAL Postgres connections. Under a burst
    // of cold starts that multiplies toward Neon's max_connections limit. The
    // pooled endpoint (-pooler hostname) routes through PgBouncer so these
    // client connections multiplex onto a handful of physical ones - the
    // 100+ concurrent user fix. The code is fully pooled-compatible; this just
    // tells ops the switch hasn't been made yet. Verify via GET /api/db-verify.
    if (isProduction && connectionString && connectionString.includes('neon.tech') && !connectionString.includes('-pooler')) {
      console.warn('[POOL] DATABASE_URL is a DIRECT Neon endpoint (hostname lacks "-pooler"). Switch to the pooled endpoint string in Vercel to support 100+ concurrent users without exhausting connections.');
    }

    poolInstance = new pg.Pool({
      connectionString: connectionString || 'postgresql://localhost:5432/fleexbid',
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
      // Optimized pooling for serverless and production environments.
      // IMPORTANT: DATABASE_URL must be the POOLED Neon endpoint (hostname ends
      // with "-pooler") so PgBouncer multiplexes these client connections onto a
      // small number of physical Postgres connections. With the pooled endpoint,
      // 15 client connections per lambda instance is safe headroom for 100+
      // concurrent users without exhausting Neon's max_connections.
      max: isProduction ? 15 : 50,
      min: isProduction ? 0 : 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Recycle connections periodically so stale backends are dropped after
      // Neon compute restarts / autoscaling events.
      maxUses: 400,
      // Identify this app's backends on the Neon dashboard / pg_stat_activity.
      application_name: 'fleexbid'
    });

    poolInstance.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL client pool:', err);
    });
  }
  return poolInstance;
}

/**
 * Normalize database row keys to camelCase to prevent case-sensitivity bugs.
 * Maps both lowercase and snake_case patterns to the expected TypeScript camelCase properties.
 */
function normalizeKeys(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const mapped: any = {};
  const keyMapping: Record<string, string> = {
    // lowercase mappings
    passwordhash: 'passwordHash',
    companyname: 'companyName',
    contactperson: 'contactPerson',
    mobilenumber: 'mobileNumber',
    gstnumber: 'gstNumber',
    pannumber: 'panNumber',
    vehicletypes: 'vehicleTypes',
    vehicletype: 'vehicleType',
    operatingstates: 'operatingStates',
    preferredroutes: 'preferredRoutes',
    pickuplocation: 'pickupLocation',
    deliverylocation: 'deliveryLocation',
    numberofvehicles: 'numberOfVehicles',
    pickupdate: 'pickupDate',
    expecteddelivery: 'expectedDelivery',
    specialinstructions: 'specialInstructions',
    vehiclespecs: 'vehicleSpecs',
    bidopeningtime: 'bidOpeningTime',
    bidclosingtime: 'bidClosingTime',
    targetrate: 'targetRate',
    awardtype: 'awardType',
    createdat: 'createdAt',
    targetedtransporterids: 'targetedTransporterIds',
    requirementid: 'requirementId',
    transporterid: 'transporterId',
    removedreason: 'removedReason',
    lastupdated: 'lastUpdated',
    awardedat: 'awardedAt',
    awardedby: 'awardedBy',
    tiebreaklog: 'tieBreakLog',
    whatsappwabaid: 'whatsappWabaId',
    whatsappphoneid: 'whatsappPhoneId',
    whatsapptoken: 'whatsappToken',
    whatsappverifytoken: 'whatsappVerifyToken',
    whatsappstatus: 'whatsappStatus',
    whatsapperror: 'whatsappError',
    smsprovider: 'smsProvider',
    smsapikey: 'smsApiKey',
    smsauthtoken: 'smsAuthToken',
    smssenderid: 'smsSenderId',
    smsstatus: 'smsStatus',
    smserror: 'smsError',
    emailprovider: 'emailProvider',
    emailapikey: 'emailApiKey',
    emailsenderaddress: 'emailSenderAddress',
    emailstatus: 'emailStatus',
    emailerror: 'emailError',
    userid: 'userId',
    useremail: 'userEmail',
    ipaddress: 'ipAddress',
    oldvalue: 'oldValue',
    newvalue: 'newValue',
    userrole: 'userRole',
    deviceid: 'deviceId',
    logintime: 'loginTime',
    lastactivity: 'lastActivity',
    refreshtoken: 'refreshToken',
    hashedotp: 'hashedOtp',
    sentat: 'sentAt',
    
    // snake_case mappings
    password_hash: 'passwordHash',
    company_name: 'companyName',
    contact_person: 'contactPerson',
    mobile_number: 'mobileNumber',
    gst_number: 'gstNumber',
    pan_number: 'panNumber',
    vehicle_types: 'vehicleTypes',
    vehicle_type: 'vehicleType',
    operating_states: 'operatingStates',
    preferred_routes: 'preferredRoutes',
    pickup_location: 'pickupLocation',
    delivery_location: 'deliveryLocation',
    number_of_vehicles: 'numberOfVehicles',
    pickup_date: 'pickupDate',
    expected_delivery: 'expectedDelivery',
    special_instructions: 'specialInstructions',
    vehicle_specs: 'vehicleSpecs',
    bid_opening_time: 'bidOpeningTime',
    bid_closing_time: 'bidClosingTime',
    target_rate: 'targetRate',
    award_type: 'awardType',
    created_at: 'createdAt',
    targeted_transporter_ids: 'targetedTransporterIds',
    requirement_id: 'requirementId',
    transporter_id: 'transporterId',
    removed_reason: 'removedReason',
    last_updated: 'lastUpdated',
    awarded_at: 'awardedAt',
    awarded_by: 'awardedBy',
    tie_break_log: 'tieBreakLog',
    whatsapp_waba_id: 'whatsappWabaId',
    whatsapp_phone_id: 'whatsappPhoneId',
    whatsapp_token: 'whatsappToken',
    whatsapp_verify_token: 'whatsappVerifyToken',
    whatsapp_status: 'whatsappStatus',
    whatsapp_error: 'whatsappError',
    sms_provider: 'smsProvider',
    sms_api_key: 'smsApiKey',
    sms_auth_token: 'smsAuthToken',
    sms_sender_id: 'smsSenderId',
    sms_status: 'smsStatus',
    sms_error: 'smsError',
    email_provider: 'emailProvider',
    email_api_key: 'emailApiKey',
    email_sender_address: 'emailSenderAddress',
    email_status: 'emailStatus',
    email_error: 'emailError',
    user_id: 'userId',
    user_email: 'userEmail',
    ip_address: 'ipAddress',
    old_value: 'oldValue',
    new_value: 'newValue',
    user_role: 'userRole',
    device_id: 'deviceId',
    login_time: 'loginTime',
    last_activity: 'lastActivity',
    refresh_token: 'refreshToken',
    hashed_otp: 'hashedOtp',
    sent_at: 'sentAt'
  };

  for (const key of Object.keys(row)) {
    const lowerKey = key.toLowerCase();
    const targetKey = keyMapping[lowerKey] || key;
    mapped[targetKey] = row[key];
  }
  return mapped;
}

/**
 * Execute raw SQL queries on the optimized pool.
 * Implements graceful exception handling.
 */
export async function queryPool(text: string, params?: any[]) {
  const pool = getDbPool();
  try {
    const res = await pool.query(text, params);
    if (res && res.rows) {
      res.rows = res.rows.map(normalizeKeys);
    }
    return res;
  } catch (error) {
    console.error(`PostgreSQL query error: ${text}`, error);
    throw error;
  }
}

/**
 * Run a query on a specific client (inside a transaction) with the same
 * camelCase key normalization as queryPool. Used by writeDB so that every
 * read and write of a transaction goes through ONE connection - required for
 * atomic multi-table writes, rollback, and snapshot isolation.
 */
export async function queryClient(client: pg.PoolClient, text: string, params?: any[]) {
  const res = await client.query(text, params);
  if (res && res.rows) {
    res.rows = res.rows.map(normalizeKeys);
  }
  return res;
}

/**
 * Diagnostics for operations tooling: live pool utilization + resolved
 * connection settings. Exposes NO credentials - only config/host metadata.
 */
export function getPoolInfo() {
  const pool = getDbPool();
  const url = process.env.DATABASE_URL || '';
  let host = 'unknown';
  let port: string | null = null;
  const match = url.match(/@([^:/?#]+)(?::(\d+))?/);
  if (match) {
    host = match[1];
    port = match[2] || null;
  }
  return {
    host,
    port,
    pooledHostname: host.includes('-pooler'),
    ssl: !!pool.options.ssl,
    max: pool.options.max,
    connectionTimeoutMillis: pool.options.connectionTimeoutMillis,
    idleTimeoutMillis: pool.options.idleTimeoutMillis,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

// NOTE: session-level advisory locks (pg_advisory_lock / pg_advisory_unlock)
// are intentionally NOT provided. Neon's pooled endpoint runs PgBouncer in
// transaction mode (pool_mode=transaction), where a session lock's owning
// "session" is returned to the pool after each statement's transaction - so
// session locks silently provide NO mutual exclusion. All cross-instance
// serialization must use TRANSACTION-scoped locks (pg_advisory_xact_lock)
// inside a real BEGIN/COMMIT transaction (see writeDB in server/db.ts).

/**
 * Run a callback inside a single database transaction on one dedicated client.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may be broken; nothing to roll back
    }
    throw error;
  } finally {
    client.release();
  }
}
