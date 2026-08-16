import nodemailer from 'nodemailer';
import { generateId } from './db';
import { queryPool } from './db_pool';
import { Requirement, Transporter } from '../src/types';

export interface EmailLog {
  id: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
  status: 'SENT' | 'FAILED';
  error: string | null;
  provider: string;
}

export interface WhatsAppLog {
  id: string;
  to: string;
  template: string;
  params: any;
  sentAt: string;
  status: 'SENT' | 'FAILED';
  error: string | null;
  provider: string;
}

export interface SmsLog {
  id: string;
  to: string;
  message: string;
  sentAt: string;
  status: 'SENT' | 'FAILED';
  error: string | null;
  provider: string;
}

/**
 * Sends SMS (Twilio or Mock) using pure fetch
 */
export async function sendSms(to: string, message: string): Promise<boolean> {
  const resConfig = await queryPool('SELECT * FROM notification_provider_configs WHERE id = $1', ['default']);
  const config = resConfig.rows[0];
  
  const logId = generateId('smslog');
  const now = new Date().toISOString();
  
  if (!config || config.smsProvider === 'mock' || !config.smsApiKey || !config.smsAuthToken) {
    // Mock Sender
    console.log(`[SMS MOCK] To: ${to} | Message: "${message}"`);
    await queryPool(
      'INSERT INTO sms_logs (id, "to", message, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [logId, to, message, now, 'SENT', null, 'mock']
    );
    return true;
  }

  // Real Twilio Sender via REST API
  try {
    const accountSid = config.smsApiKey;
    const authToken = config.smsAuthToken;
    const fromNumber = config.smsSenderId;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', fromNumber);
    params.append('Body', message);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const resData = await response.json();

    if (response.ok) {
      await queryPool(
        'INSERT INTO sms_logs (id, "to", message, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [logId, to, message, now, 'SENT', null, 'twilio']
      );
      return true;
    } else {
      const errorMsg = resData.message || 'Twilio API Error';
      throw new Error(errorMsg);
    }
  } catch (error: any) {
    console.error(`Twilio SMS failed to send: ${error.message}`);
    await queryPool(
      'INSERT INTO sms_logs (id, "to", message, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [logId, to, message, now, 'FAILED', error.message, 'twilio']
    );
    return false;
  }
}

export interface EmailSendResult {
  success: boolean;
  provider: 'resend' | 'smtp' | 'mock';
  error?: string | null;
}

/**
 * Sends Email (using Resend API, SMTP/Gmail, or Mock fallback)
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<EmailSendResult> {
  const resConfig = await queryPool('SELECT * FROM notification_provider_configs WHERE id = $1', ['default']);
  const config = resConfig.rows[0];
  
  const logId = generateId('emaillog');
  const now = new Date().toISOString();

  const resendApiKey = process.env.RESEND_API_KEY || (config && config.emailProvider === 'resend' ? config.emailApiKey : null);
  const resendFrom = process.env.RESEND_FROM_EMAIL || (config ? config.emailSenderAddress : null) || 'onboarding@resend.dev';

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);

  // 1. Try SMTP / Gmail if configured via environment variables
  if (smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      const info = await transporter.sendMail({
        from: `FleexBid Secure Gateway <${smtpUser}>`,
        to,
        subject,
        html: body,
      });

      console.log(`[EMAIL SMTP SUCCESS] MessageId: ${info.messageId} | To: ${to}`);
      await queryPool(
        'INSERT INTO email_logs (id, "to", subject, body, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [logId, to, subject, body, now, 'SENT', null, 'smtp']
      );
      return { success: true, provider: 'smtp' };
    } catch (error: any) {
      console.error(`SMTP Email failed to send to ${to}: ${error.message}`);
      await queryPool(
        'INSERT INTO email_logs (id, "to", subject, body, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [logId, to, subject, body, now, 'FAILED', error.message, 'smtp']
      );
    }
  }

  // 2. Try Resend API if API Key is configured
  if (resendApiKey) {
    try {
      const url = 'https://api.resend.com/emails';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [to],
          subject: subject,
          html: body
        })
      });

      const resData = await response.json();

      if (response.ok) {
        await queryPool(
          'INSERT INTO email_logs (id, "to", subject, body, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [logId, to, subject, body, now, 'SENT', null, 'resend']
        );
        return { success: true, provider: 'resend' };
      } else {
        const errorMsg = resData.message || 'Resend API Error';
        throw new Error(errorMsg);
      }
    } catch (error: any) {
      console.error(`Resend Email failed to send to ${to}: ${error.message}`);
      await queryPool(
        'INSERT INTO email_logs (id, "to", subject, body, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [logId, to, subject, body, now, 'FAILED', error.message, 'resend']
      );
    }
  }

  // 3. Fallback to Mock Sender
  console.log(`[EMAIL MOCK] To: ${to} | Subject: "${subject}" | Body: "${body.substring(0, 100)}..."`);
  await queryPool(
    'INSERT INTO email_logs (id, "to", subject, body, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [logId, to, subject, body, now, 'SENT', 'Mock delivery (SMTP/Resend configuration missing)', 'mock']
  );
  return { success: true, provider: 'mock' };
}

/**
 * Sends WhatsApp (Meta Cloud API or Mock) using pure fetch
 */
export async function sendWhatsApp(to: string, template: string, params: any): Promise<boolean> {
  const resConfig = await queryPool('SELECT * FROM notification_provider_configs WHERE id = $1', ['default']);
  const config = resConfig.rows[0];
  
  const logId = generateId('walog');
  const now = new Date().toISOString();
  
  if (!config || !config.whatsappPhoneId || !config.whatsappToken) {
    // Mock Sender
    console.log(`[WHATSAPP MOCK] To: ${to} | Template: "${template}" | Params: ${JSON.stringify(params)}`);
    await queryPool(
      'INSERT INTO whatsapp_logs (id, "to", template, params, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [logId, to, template, JSON.stringify(params), now, 'SENT', null, 'mock']
    );
    return true;
  }

  // Real WhatsApp Business Platform API via Meta Cloud API
  try {
    const phoneId = config.whatsappPhoneId;
    const token = config.whatsappToken;

    const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
    
    const components: any[] = [];
    if (params && params.bodyParams) {
      components.push({
        type: 'body',
        parameters: params.bodyParams.map((p: string) => ({ type: 'text', text: p }))
      });
    }
    
    if (params && params.buttonUrlParam) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: params.buttonUrlParam }]
      });
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace('+', ''),
        type: 'template',
        template: {
          name: template,
          language: { code: 'en_US' },
          components
        }
      })
    });

    const resData = await response.json();

    if (response.ok) {
      await queryPool(
        'INSERT INTO whatsapp_logs (id, "to", template, params, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [logId, to, template, JSON.stringify(params), now, 'SENT', null, 'meta']
      );
      return true;
    } else {
      const errorMsg = resData.error?.message || 'Meta API Error';
      throw new Error(errorMsg);
    }
  } catch (error: any) {
    console.error(`Meta WhatsApp failed to send: ${error.message}`);
    await queryPool(
      'INSERT INTO whatsapp_logs (id, "to", template, params, sent_at, status, error, provider) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [logId, to, template, JSON.stringify(params), now, 'FAILED', error.message, 'meta']
    );
    return false;
  }
}

/**
 * Trigger All-Channel Notification on requirement publish
 */
export async function notifyPublishedRequirement(req: Requirement, tr: Transporter, appUrl: string) {
  const deepLink = `${appUrl}/bid/${req.id}`;
  const pickupD = new Date(req.pickupDate).toLocaleDateString();
  const closingT = new Date(req.bidClosingTime).toLocaleTimeString();
  
  // 1. WhatsApp
  const waParams = {
    bodyParams: [
      `${req.pickupLocation} → ${req.deliveryLocation}`,
      req.vehicleType,
      pickupD,
      closingT
    ],
    buttonUrlParam: `bid/${req.id}`
  };
  await sendWhatsApp(tr.mobileNumber, 'new_requirement_invite', waParams);

  // 2. SMS
  const specsSnippet = req.vehicleSpecs ? ` Vehicle specs: ${req.vehicleSpecs.slice(0, 100)}${req.vehicleSpecs.length > 100 ? '...' : ''}.` : '';
  const smsMessage = `FleexBid: New bid Mumbai to Delhi (${req.vehicleType}). Closes ${closingT} on ${pickupD}.${specsSnippet} Link: ${deepLink}`;
  await sendSms(tr.mobileNumber, smsMessage);

  // 3. Email
  const emailBody = `
    <div style="font-family: sans-serif; padding: 20px; color: #333;">
      <h2 style="color: #2563eb;">New Transport Requirement Available</h2>
      <p>Dear ${tr.contactPerson},</p>
      <p>You are invited to bid on the following requirement:</p>
      <table style="width: 100%; max-width: 600px; border-collapse: collapse; margin-top: 15px; margin-bottom: 25px;">
        <tr style="background-color: #f3f4f6;"><td style="padding: 8px; font-weight: bold; width: 150px;">Requirement ID:</td><td style="padding: 8px;">${req.id}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Route:</td><td style="padding: 8px;">${req.pickupLocation} &rarr; ${req.deliveryLocation}</td></tr>
        <tr style="background-color: #f3f4f6;"><td style="padding: 8px; font-weight: bold;">Vehicle Type:</td><td style="padding: 8px;">${req.vehicleType}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Material / Weight:</td><td style="padding: 8px;">${req.material} (${req.weight} Tons)</td></tr>
        ${req.vehicleSpecs ? `<tr style="background-color: #fef3c7;"><td style="padding: 8px; font-weight: bold;">Vehicle Specifications / Remarks:</td><td style="padding: 8px;">${req.vehicleSpecs}</td></tr>` : ''}
        <tr style="background-color: #f3f4f6;"><td style="padding: 8px; font-weight: bold;">Pickup Date:</td><td style="padding: 8px;">${pickupD}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Bid Closing Time:</td><td style="padding: 8px; color: #dc2626; font-weight: bold;">${closingT} (${new Date(req.bidClosingTime).toLocaleDateString()})</td></tr>
      </table>
      <div style="margin-top: 20px;">
        <a href="${deepLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View and Submit Bid</a>
      </div>
    </div>
  `;
  await sendEmail(tr.email, `📢 New Bidding Invitation: ${req.id} (${req.pickupLocation} -> ${req.deliveryLocation})`, emailBody);
}

/**
 * Trigger All-Channel Notification on bid winning
 */
export async function notifyAwardedBid(req: Requirement, tr: Transporter, amount: number, appUrl: string) {
  const portalLink = `${appUrl}/bid/${req.id}`;
  
  // 1. WhatsApp
  const waParams = {
    bodyParams: [
      req.id,
      `${req.pickupLocation} → ${req.deliveryLocation}`,
      `₹${amount.toLocaleString()}`
    ],
    buttonUrlParam: `bid/${req.id}`
  };
  await sendWhatsApp(tr.mobileNumber, 'bid_awarded', waParams);

  // 2. SMS
  const smsMessage = `Congratulations! FleexBid ${req.id} (${req.pickupLocation} to ${req.deliveryLocation}) has been awarded to you at ₹${amount.toLocaleString()}. Details: ${portalLink}`;
  await sendSms(tr.mobileNumber, smsMessage);

  // 3. Email
  const emailBody = `
    <div style="font-family: sans-serif; padding: 20px; color: #333;">
      <h2 style="color: #16a34a;">&nbsp;&nbsp;Congratulations! Your Bid Has Been Awarded</h2>
      <p>Dear ${tr.contactPerson},</p>
      <p>We are pleased to inform you that your quotation has been selected and awarded for the following transport requirement:</p>
      <table style="width: 100%; max-width: 600px; border-collapse: collapse; margin-top: 15px; margin-bottom: 25px;">
        <tr style="background-color: #f3f4f6;"><td style="padding: 8px; font-weight: bold; width: 150px;">Requirement ID:</td><td style="padding: 8px;">${req.id}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Route:</td><td style="padding: 8px;">${req.pickupLocation} &rarr; ${req.deliveryLocation}</td></tr>
        <tr style="background-color: #f3f4f6;"><td style="padding: 8px; font-weight: bold;">Vehicle Type:</td><td style="padding: 8px;">${req.vehicleType}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Awarded Rate:</td><td style="padding: 8px; font-weight: bold; color: #16a34a; font-size: 16px;">₹${amount.toLocaleString()}</td></tr>
        <tr style="background-color: #f3f4f6;"><td style="padding: 8px; font-weight: bold;">Pickup Date:</td><td style="padding: 8px;">${new Date(req.pickupDate).toLocaleDateString()}</td></tr>
      </table>
      <div style="margin-top: 20px;">
        <a href="${portalLink}" style="background-color: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View Award Details</a>
      </div>
    </div>
  `;
  await sendEmail(tr.email, `🎉 Congratulations! Awarded Bid: ${req.id}`, emailBody);
}

/**
 * Trigger losing notification
 */
export async function notifyLostBid(req: Requirement, tr: Transporter) {
  const emailBody = `
    <div style="font-family: sans-serif; padding: 20px; color: #333;">
      <h2>Transport Bid Result: ${req.id}</h2>
      <p>Dear ${tr.contactPerson},</p>
      <p>Thank you for participating in our reverse auction for requirement <strong>${req.id}</strong> Strong>${req.pickupLocation} to ${req.deliveryLocation}).</p>
      <p>Your quotation was not selected for this round. We appreciate your effort and participation, and look forward to your active bidding on our future requirements.</p>
      <p>Best regards,<br/>Logistics & Procurement Team</p>
    </div>
  `;
  await sendEmail(tr.email, `Transport Bid Result: ${req.id}`, emailBody);
}
