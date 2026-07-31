/**
 * LogiBid Type Definitions
 */

export type UserRole = 'SUPER_ADMIN' | 'LOGISTICS' | 'TRANSPORTER';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: 'SUPER_ADMIN' | 'LOGISTICS';
  name: string;
  status: string;
}

export interface Transporter {
  id: string;
  companyName: string;
  contactPerson: string;
  email: string;
  mobileNumber: string;
  gstNumber: string;
  panNumber: string;
  vehicleTypes: string[];
  operatingStates: string[];
  preferredRoutes: string[];
  status: string;
  passwordHash?: string;
}

export type RequirementStatus = 'DRAFT' | 'LIVE' | 'CLOSED' | 'AWARDED' | 'CANCELLED' | 'TIE_RESOLUTION_REQUIRED' | 'active' | 'published';

export interface Requirement {
  id: string; // e.g. TR-2026-0001
  pickupLocation: string;
  deliveryLocation: string;
  material: string;
  weight: number;
  vehicleType: string;
  numberOfVehicles: number;
  pickupDate: string;
  expectedDelivery: string;
  specialInstructions: string;
  documents: string[]; // Filenames or URLs
  bidOpeningTime: string;
  bidClosingTime: string;
  targetRate: number | null;
  awardType: 'MANUAL' | 'AUTOMATIC';
  status: RequirementStatus;
  createdAt: string;
  targeted_transporter_ids?: string[]; // Specified transporter IDs
  targetedTransporterIds?: string[];
}

export interface RequirementInvitation {
  id: string;
  requirementId: string;
  transporterId: string;
  status: 'INVITED' | 'REMOVED';
  removedReason: string | null;
}

export interface Bid {
  id: string;
  requirementId: string;
  transporterId: string;
  amount: number;
  timestamp: string;
  lastUpdated: string;
}

export interface BidHistory {
  id: string;
  requirementId: string;
  transporterId: string;
  amount: number;
  timestamp: string;
}

export interface Award {
  id: string;
  requirementId: string;
  transporterId: string;
  amount: number;
  awardedAt: string;
  awardedBy: string; // User ID or 'SYSTEM'
  tieBreakLog: string | null;
}

export interface NotificationProviderConfig {
  id: string;
  // WhatsApp settings
  whatsappWabaId: string;
  whatsappPhoneId: string;
  whatsappToken: string;
  whatsappVerifyToken: string;
  whatsappStatus: 'CONNECTED' | 'NOT_CONNECTED' | 'ERROR';
  whatsappError: string | null;
  // SMS settings
  smsProvider: 'twilio' | 'msg91' | 'mock';
  smsApiKey: string;
  smsAuthToken: string;
  smsSenderId: string;
  smsStatus: 'CONNECTED' | 'NOT_CONNECTED' | 'ERROR';
  smsError: string | null;
  // Email settings
  emailProvider: 'resend' | 'mock';
  emailApiKey: string;
  emailSenderAddress: string;
  emailStatus: 'CONNECTED' | 'NOT_CONNECTED' | 'ERROR';
  emailError: string | null;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  userEmail: string | null;
  role: UserRole | null;
  action: string;
  timestamp: string;
  ipAddress: string | null;
  device: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface Session {
  id: string;
  transporterId: string | null;
  userId: string | null;
  userRole: UserRole;
  deviceId: string;
  browser: string;
  os: string;
  ipAddress: string;
  loginTime: string;
  lastActivity: string;
  refreshToken: string;
  expiry: string;
}

export interface TransporterRank {
  transporterId: string;
  companyName: string;
  amount: number | null;
  rank: number | null; // 1 = L1, 2 = L2, etc. Tied bids share ranks
  timestamp: string | null;
  isL1: boolean;
  status: 'PENDING' | 'SUBMITTED';
}

export interface EmailOtpVerification {
  id: string;
  email: string;
  hashedOtp: string;
  expiry: string; // ISO String
  attempts: number;
}
