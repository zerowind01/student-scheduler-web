// Netlify Serverless Function for Realtime Cloud Sync
let cloudMemoryStore = {};

exports.handler = async function (event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const syncKey = (event.queryStringParameters && event.queryStringParameters.key) || 'school_demo_2026';

  if (event.httpMethod === 'POST') {
    try {
      const data = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      cloudMemoryStore[syncKey] = data;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, updatedAt: data ? data.updatedAt : Date.now() }),
      };
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: e.message }) };
    }
  } else {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(cloudMemoryStore[syncKey] || {}),
    };
  }
};
