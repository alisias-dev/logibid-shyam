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

    poolInstance = new pg.Pool({
      connectionString: connectionString || 'postgresql://localhost:5432/logibid',
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
      // Optimized pooling for serverless and production environments
      max: isProduction ? 10 : 50,
      min: isProduction ? 0 : 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
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
