const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();

// Add body size limit to prevent memory issues
app.use(express.json({ limit: '1mb' }));

const {
  SONARQUBE_URL,
  SONARQUBE_TOKEN,
  SERVICENOW_URL,
  SERVICENOW_CLIENT_ID,
  SERVICENOW_CLIENT_SECRET,
  SERVICENOW_INCIDENT_UI_PATH = 'nav_to.do?uri=incident.do?sys_id=',
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE = 'false',
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  EMAIL_TO,
  PORT = 3000,
} = process.env;

// Validate required environment variables at startup
function validateEnv() {
  const required = [
    'SONARQUBE_URL',
    'SONARQUBE_TOKEN',
    'SERVICENOW_URL',
    'SERVICENOW_CLIENT_ID',
    'SERVICENOW_CLIENT_SECRET'
  ];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Token cache to avoid fetching on every request
let cachedToken = null;
let tokenExpiry = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryOperation(fn, { retries = 3, baseDelayMs = 500, factor = 2, jitterMs = 100, label = 'operation' } = {}) {
  let attempt = 0;
  let lastError;
  while (attempt <= retries) {
    try {
      if (attempt > 0) console.log(`[retry] Attempt ${attempt}/${retries} for ${label}`);
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const delay = baseDelayMs * Math.pow(factor, attempt) + Math.floor(Math.random() * jitterMs);
      console.warn(`[retry] ${label} failed: ${err.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
      attempt++;
    }
  }
  throw lastError;
}

async function getSonarQubeProject(projectKey) {
  const url = `${SONARQUBE_URL}/api/projects/search?projects=${encodeURIComponent(projectKey)}`;
  const headers = { Authorization: `Basic ${Buffer.from(`${SONARQUBE_TOKEN}:`).toString('base64')}` };
  
  try {
    const { data } = await axios.get(url, { headers, timeout: 15000 });
    return data;
  } catch (error) {
    if (error.response) {
      throw new Error(`SonarQube API error: ${error.response.status} - ${error.response.statusText}`);
    } else if (error.request) {
      throw new Error(`SonarQube API unreachable: ${error.message}`);
    }
    throw error;
  }
}

async function getServiceNowToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 300000) {
    console.log('[token] Using cached ServiceNow token');
    return cachedToken;
  }

  const url = `${SERVICENOW_URL}/oauth_token.do`;
  const params = { 
    grant_type: 'client_credentials', 
    client_id: SERVICENOW_CLIENT_ID, 
    client_secret: SERVICENOW_CLIENT_SECRET 
  };
  
  try {
    const { data } = await axios.post(url, null, { params, timeout: 15000 });
    if (!data?.access_token) throw new Error('ServiceNow token missing in response');
    
    // Cache token (default to 30 min if no expires_in)
    cachedToken = data.access_token;
    const expiresIn = data.expires_in || 1800;
    tokenExpiry = Date.now() + (expiresIn * 1000);
    console.log('[token] Fetched new ServiceNow token');
    
    return cachedToken;
  } catch (error) {
    if (error.response) {
      throw new Error(`ServiceNow OAuth error: ${error.response.status} - ${error.response.data?.error || error.response.statusText}`);
    } else if (error.request) {
      throw new Error(`ServiceNow OAuth unreachable: ${error.message}`);
    }
    throw error;
  }
}

async function createServiceNowIncident(token, payload) {
  const url = `${SERVICENOW_URL}/api/now/table/incident`;
  const headers = { 
    Authorization: `Bearer ${token}`, 
    'Content-Type': 'application/json' 
  };
  
  try {
    const { data } = await axios.post(url, payload, { headers, timeout: 20000 });
    if (!data?.result) throw new Error('Incident creation failed: no result in response');
    return data.result;
  } catch (error) {
    // Clear cached token if we get auth error
    if (error.response?.status === 401) {
      console.warn('[token] Clearing cached token due to 401 error');
      cachedToken = null;
      tokenExpiry = null;
    }
    
    if (error.response) {
      throw new Error(`ServiceNow incident error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      throw new Error(`ServiceNow incident API unreachable: ${error.message}`);
    }
    throw error;
  }
}

function getTransport() {
  const secure = String(SMTP_SECURE).toLowerCase() === 'true';
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || (secure ? 465 : 587)),
    secure,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

async function sendIncidentEmail({ incident, projectKey, projectName }) {
  if (!SMTP_HOST || !EMAIL_FROM || !EMAIL_TO) {
    console.warn('[email] SMTP not configured; skipping');
    return;
  }
  
  try {
    const transport = getTransport();
    const link = `${SERVICENOW_URL}/${SERVICENOW_INCIDENT_UI_PATH}${incident.sys_id}`;
    const subject = `Incident: ${incident.number || incident.sys_id} • Project: ${projectName || projectKey}`;
    const timestamp = new Date().toISOString();
    const text = `Incident created for ${projectName || projectKey}\nNumber: ${incident.number}\nLink: ${link}\nTimestamp: ${timestamp}`;
    
    await transport.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, text });
    console.log(`[email] Sent notification for ${incident.number}`);
  } catch (error) {
    // Don't throw - email failure shouldn't break incident creation
    console.error(`[email] Failed to send notification: ${error.message}`);
  }
}

// Healthz endpoint
app.get('/healthz', async (req, res) => {
  const deep = String(req.query.deep || '').toLowerCase() === 'true';
  const base = { 
    status: 'ok', 
    uptime_sec: Math.round(process.uptime()), 
    timestamp: new Date().toISOString() 
  };
  
  if (!deep) return res.status(200).json(base);
  
  const details = { ...base, checks: {} };
  
  // Check SonarQube
  try {
    const vResp = await axios.get(`${SONARQUBE_URL}/api/server/version`, { 
      timeout: 8000,
      headers: { Authorization: `Basic ${Buffer.from(`${SONARQUBE_TOKEN}:`).toString('base64')}` }
    });
    details.checks.sonarqube = { reachable: true, version: vResp.data };
  } catch (e) {
    details.checks.sonarqube = { reachable: false, error: e.message };
  }
  
  // Check ServiceNow OAuth
  try {
    const token = await getServiceNowToken();
    details.checks.servicenow = { oauth_ok: Boolean(token) };
  } catch (e) {
    details.checks.servicenow = { oauth_ok: false, error: e.message };
  }
  
  const statusCode = details.checks.sonarqube.reachable && details.checks.servicenow.oauth_ok ? 200 : 503;
  return res.status(statusCode).json(details);
});

// Manual batch endpoint
app.post('/create-incidents', async (req, res) => {
  const { projectKeys } = req.body;
  
  if (!Array.isArray(projectKeys) || projectKeys.length === 0) {
    return res.status(400).json({ error: 'projectKeys must be non-empty array' });
  }
  
  // Limit batch size to prevent overload
  if (projectKeys.length > 50) {
    return res.status(400).json({ error: 'projectKeys array too large (max 50)' });
  }
  
  try {
    const token = await retryOperation(() => getServiceNowToken(), { 
      retries: 3, 
      label: 'servicenow-oauth' 
    });
    
    const results = [];
    
    for (const key of projectKeys) {
      try {
        const projectData = await retryOperation(() => getSonarQubeProject(key), { 
          retries: 2, 
          label: `sonarqube-${key}` 
        });
        
        const component = projectData?.components?.[0];
        if (!component) { 
          results.push({ projectKey: key, status: 'not_found' }); 
          continue; 
        }
        
        const payload = { 
          short_description: `SonarQube issue: ${component.name}`, 
          description: `Review analysis for ${component.name} (${key})`,
          urgency: '3',
          impact: '3'
        };
        
        const incident = await retryOperation(() => createServiceNowIncident(token, payload), { 
          retries: 3, 
          label: `incident-${key}` 
        });
        
        // Email failure won't break the flow
        await sendIncidentEmail({ incident, projectKey: key, projectName: component.name });
        
        results.push({ 
          projectKey: key, 
          status: 'incident_created', 
          incident: {
            number: incident.number,
            sys_id: incident.sys_id
          }
        });
      } catch (e) { 
        console.error(`[batch] Error processing ${key}:`, e.message);
        results.push({ projectKey: key, status: 'error', error: e.message }); 
      }
    }
    
    return res.json({ message: 'Batch processed', results });
  } catch (error) {
    console.error('[batch] Fatal error:', error.message);
    return res.status(500).json({ error: 'Batch processing failed', details: error.message });
  }
});

// SonarQube webhook endpoint
app.post('/sonarqube-webhook', async (req, res) => {
  try {
    const { project, qualityGate } = req.body;
    const projectKey = project?.key;
    const projectName = project?.name;
    const status = qualityGate?.status;
    
    if (!projectKey) {
      return res.status(400).json({ error: 'Missing project key in webhook payload' });
    }
    
    if (status !== 'OK') {
      const token = await retryOperation(() => getServiceNowToken(), { 
        retries: 3, 
        label: 'servicenow-oauth' 
      });
      
      const payload = { 
        short_description: `Quality Gate failed: ${projectName || projectKey}`, 
        description: `Project: ${projectName || projectKey}\nKey: ${projectKey}\nQuality Gate Status: ${status}`,
        urgency: '2',
        impact: '2'
      };
      
      const incident = await retryOperation(() => createServiceNowIncident(token, payload), { 
        retries: 3, 
        label: `incident-${projectKey}` 
      });
      
      // Email failure won't break the flow
      await sendIncidentEmail({ incident, projectKey, projectName });
      
      return res.json({ 
        message: 'Incident created from webhook', 
        incident: {
          number: incident.number,
          sys_id: incident.sys_id
        }
      });
    }
    
    return res.json({ message: 'Quality Gate OK, no action needed' });
  } catch (error) {
    console.error('[webhook] Error:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed', details: error.message });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Validate environment and start server
try {
  validateEnv();
  app.listen(PORT, () => {
    console.log(`Gateway running on port ${PORT}`);
    console.log(`Environment validated - all required variables present`);
  });
} catch (error) {
  console.error(`Failed to start server: ${error.message}`);
  process.exit(1);
}