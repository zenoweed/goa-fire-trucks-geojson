/**
 * Fire Truck API Cache Script
 *
 * This script fetches data from the Goa Fire Department GPS API
 * and saves it to a cached JSON file that can be served via GitHub Pages.
 */

import fetch from 'node-fetch';
import https from 'https';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const API_BASE_URL = 'https://3.7.238.246/webservice';
const API_USERNAME = 'cnt-fire.goa@nic.in';
const API_PASSWORD = 'cnt@123';
const API_COMPANY_NAME = 'Directorate of Fire Emergency Services';
const API_PROJECT_ID = 37;

const DIRECTORY_CACHE = path.join(__dirname, 'data');
const DIRECTORY_CSV = path.join(__dirname, 'data/csv');
const FILE_DEBUG_LOG = path.join(__dirname, 'debug-log.txt');
const FILE_COVERAGE = path.join(__dirname, 'data/coverage.csv');
const FILE_OUTPUT_JSON = path.join(__dirname, 'data/goa-fire-trucks.geojson');
const FILE_OUTPUT_GPX = path.join(__dirname, 'data/goa-fire-trucks-gpx-YMD.geojson');

// Create HTTPS agent that allows IP addresses (for APIs that use IP instead of domain)
// This is necessary because SSL certificates are typically issued for domain names, not IPs
const httpsAgent = new https.Agent({ rejectUnauthorized: false, });

function getISTISOString() {
  const date = new Date();
  return date.toISOString();
}

function getISTDayString() {
  const date = new Date();
  return date.toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).replace(/-/g, '');
}

// Helper function to log debug information
function debugLog(message, data = null) {
  const timestamp = getISTISOString();
  let logMessage = `[${timestamp}] ${message}\n`;

  if (data) {
    logMessage += typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    logMessage += '\n';
  }

  console.log(message);
  fs.appendFileSync(FILE_DEBUG_LOG, logMessage);
}

// Helper to check if a value could be a valid Goa coordinate
function isValidGoaCoordinate(value, type) {
  if (!value) return false;

  let num;
  if (typeof value === 'number') {
    num = value;
  } else {
    // Try to handle comma-formatted numbers (e.g., "15,486755" instead of "15.486755")
    const cleanValue = value.toString().replace(',', '.');
    num = parseFloat(cleanValue);
  }

  if (isNaN(num)) return false;

  if (type === 'lat') {
    // Latitude range for Goa, India
    return num >= 14.5 && num <= 16.0;
  } else if (type === 'lng') {
    // Longitude range for Goa, India
    return num >= 73.5 && num <= 74.5;
  } else {
    // If type is not specified, check both ranges
    return (num >= 14.5 && num <= 16.0) || (num >= 73.5 && num <= 74.5);
  }
}

// Add a new function for managing daily GPX tracks
function updateDailyGpxTracks(trucks) {
  // Generate today's date in YYYYMMDD format (IST)
  const gpxFilePath = FILE_OUTPUT_GPX.replace('YMD', getISTDayString());

  // Initialize tracks object - either from existing file or new
  let tracksGeoJson = {
    type: 'FeatureCollection',
    metadata: {
      date: getISTDayString(),
      source: 'Directorate of Fire Emergency Services, Govt. of Goa',
      description: 'Daily GPS tracks of fire trucks'
    },
    features: []
  };

  // Load existing tracks file if it exists
  if (fs.existsSync(gpxFilePath)) {
    const existingContent = fs.readFileSync(gpxFilePath, 'utf8');
    tracksGeoJson = JSON.parse(existingContent);
    debugLog(`Loaded existing GPX tracks file for ${(getISTDayString())}`);
  } else {
    debugLog(`Creating new GPX tracks file for ${(getISTDayString())}`);
  }

  // Create map of vehicle IDs to existing track features
  const vehicleTrackMap = {};
  tracksGeoJson.features.forEach((feature, index) => {
    if (feature.properties && feature.properties.Vehicle_No) {
      vehicleTrackMap[feature.properties.Vehicle_No] = index;
    }
  });

  // Update tracks for each truck
  trucks.forEach(truck => {
    const vehicleId = truck.Vehicle_No;
    // Use IST timestamp for created/updated fields if available, otherwise current IST time
    const timestamp = truck.Datetime+'+05:30' || getISTISOString();
    const coords = [parseFloat(truck.Longitude), parseFloat(truck.Latitude)];

    if (!vehicleId || !isValidGoaCoordinate(coords[0]) || !isValidGoaCoordinate(coords[1])) {
      debugLog(`Skipping GPX update for vehicle with invalid data: ${vehicleId || 'unknown'}`);
      return;
    }

    // Check if this vehicle already has a track
    if (vehicleTrackMap.hasOwnProperty(vehicleId)) {
      // Update existing track
      const featureIndex = vehicleTrackMap[vehicleId];
      const feature = tracksGeoJson.features[featureIndex];

      // Add point to coordinates if it's not a duplicate of the last point
      const existingCoords = feature.geometry.coordinates;
      const lastCoord = existingCoords.length > 0 ? existingCoords[existingCoords.length - 1] : null;

      // Only add if coordinates are different from the last point (avoid duplicates when stationary)
      if (!lastCoord || lastCoord[0] !== coords[0] || lastCoord[1] !== coords[1]) {
        feature.geometry.coordinates.push(coords);
        feature.properties.lastUpdated = timestamp;
      }
    } else {
      // Create new track for this vehicle
      const newFeature = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [coords]
        },
        properties: {
          Vehicle_No: vehicleId,
          Vehicle_Name: truck.Vehicle_Name || '',
          Branch: truck.Branch || '',
          created: timestamp,
          lastUpdated: timestamp
        }
      };

      tracksGeoJson.features.push(newFeature);
      vehicleTrackMap[vehicleId] = tracksGeoJson.features.length - 1;
    }
  });

  // Update the metadata
  tracksGeoJson.metadata.lastUpdated = getISTISOString();
  tracksGeoJson.metadata.count = tracksGeoJson.features.length;

  // Write the updated file
  fs.writeFileSync(gpxFilePath, JSON.stringify(tracksGeoJson, null, 2));
  debugLog(`Updated GPX tracks file with ${tracksGeoJson.features.length} vehicle tracks`);

  return gpxFilePath;
}

// Step 1: Generate access token
async function generateAccessToken() {
  debugLog('Step 1: Generating access token...');
  const tokenUrl = `${API_BASE_URL}?token=generateAccessToken`;

  // Try different field name variations
  const requestVariations = [
    { Username: API_USERNAME, password: API_PASSWORD },
    { username: API_USERNAME, password: API_PASSWORD },
    { Username: API_USERNAME, Password: API_PASSWORD },
    { username: API_USERNAME, Password: API_PASSWORD },
    { user: API_USERNAME, pass: API_PASSWORD },
    { User: API_USERNAME, Pass: API_PASSWORD }
  ];

  for (let i = 0; i < requestVariations.length; i++) {
    const requestBody = requestVariations[i];
    debugLog(`Attempt ${i + 1}: Token URL: ${tokenUrl}`);
    debugLog(`Request body: ${JSON.stringify(requestBody)}`);

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      agent: httpsAgent
    });

    debugLog(`Token generation response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      debugLog(`HTTP error: ${errorText}`);
      if (i < requestVariations.length - 1) {
        debugLog(`Trying next variation...`);
        continue;
      }
      throw new Error(`Token generation failed with status ${response.status}: ${errorText}`);
    }

    const tokenData = await response.json();
    debugLog(`Full token response: ${JSON.stringify(tokenData)}`);

    // Check for error response format (result: 0 indicates error)
    if (tokenData.result === 0 || tokenData.result === '0') {
      const errorMsg = tokenData.message || 'Unknown server error';
      if (i < requestVariations.length - 1) {
        debugLog(`Server error with this variation, trying next: ${errorMsg}`);
        continue;
      }
      throw new Error(`Server returned error: ${errorMsg}`);
    }

    // Extract token from response
    // The token might be in different formats, check common fields
    let token = tokenData.token || tokenData.Token || tokenData.access_token || tokenData.accessToken;

    // Also check if result contains the token (some APIs return result: 1 with token in data)
    if (!token && tokenData.data) {
      token = tokenData.data.token || tokenData.data.Token || tokenData.data;
    }

    if (!token && typeof tokenData === 'string') {
      token = tokenData;
    }

    // Check if result is success (1) and token is in a different field
    if (!token && (tokenData.result === 1 || tokenData.result === '1')) {
      // Try to find token in any field
      for (const [key, value] of Object.entries(tokenData)) {
        if (key !== 'result' && key !== 'message' && value && typeof value === 'string') {
          token = value;
          debugLog(`Found token in field '${key}'`);
          break;
        }
      }
    }

    if (!token) {
      if (i < requestVariations.length - 1) {
        debugLog(`Token not found in response, trying next variation...`);
        continue;
      }
      throw new Error(`Token not found in response. Response: ${JSON.stringify(tokenData)}`);
    }

    debugLog('Access token generated successfully');
    return token;
  }

  // If we get here, all variations failed
  throw new Error('All authentication attempts failed. Please check credentials and API documentation.');
}

// Step 2: Fetch live data using the access token
async function fetchLiveData(authToken) {
  debugLog('Step 2: Fetching live data with access token...');
  const dataUrl = `${API_BASE_URL}?token=getTokenBaseLiveData&ProjectId=${API_PROJECT_ID}`;

  const response = await fetch(dataUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'auth-code': authToken
    },
    body: JSON.stringify({
      company_names: API_COMPANY_NAME,
      format: 'json'
    }),
    agent: httpsAgent
  });

  debugLog(`Live data response status: ${response.status}`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Live data fetch failed with status ${response.status}: ${errorText}`);
  }

  const jsonData = await response.json();
  debugLog(`Received JSON response: ${JSON.stringify(jsonData).substring(0, 500)}...`);

  return jsonData;
}

// Helper to escape CSV fields
function escapeCsvField(field) {
  if (field === null || field === undefined) return '';
  const stringField = String(field);
  if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
    return `"${stringField.replace(/"/g, '""')}"`;
  }
  return stringField;
}

// Function to update daily CSV log
function updateDailyCsvLog(trucks) {
  const today = getISTDayString();
  const csvFilePath = path.join(DIRECTORY_CSV, `goa-fire-trucks-${today}.csv`);

  // If file doesn't exist, write headers
  if (!fs.existsSync(csvFilePath)) {
    fs.writeFileSync(csvFilePath, ['Timestamp', 'Vehicle_No', 'Latitude', 'Longitude', 'Speed', 'Status', 'Location', 'Branch'].join(',') + '\n');
  }

  const timestamp = getISTISOString();

  const newLines = trucks.map(truck => {
    const row = [
      timestamp,
      truck.Vehicle_No,
      truck.Latitude,
      truck.Longitude,
      truck.Speed,
      truck.Status,
      truck.Location,
      truck.Branch
    ];
    return row.map(escapeCsvField).join(',');
  });

  if (newLines.length > 0) {
    fs.appendFileSync(csvFilePath, newLines.join('\n') + '\n');
  }

  return csvFilePath;
}

// Function to update coverage CSV
function updateCoverageCsv(testStatus) {
  const headers = ['Date', 'Filename', 'Updated_At', 'Status'];
  const today = getISTDayString();
  const todayFormatted = `${today.substring(0, 4)}-${today.substring(4, 6)}-${today.substring(6, 8)}`;
  const todayFilename = `goa-fire-trucks-${today}.csv`;

  // Preserve all historical rows; drop stale today entry if any
  let existingRows = [];
  if (fs.existsSync(FILE_COVERAGE)) {
    existingRows = fs.readFileSync(FILE_COVERAGE, 'utf8')
      .split('\n').slice(1)                             // skip header
      .filter(line => line.trim())
      .map(line => {
        const [date, filename, updatedAt, status] = line.split(',');
        return { Date: date, Filename: filename, Updated_At: updatedAt, Status: status };
      })
      .filter(row => row.Filename !== todayFilename);   // remove today's stale entry
  }

  const coverageData = [
    { Date: todayFormatted, Filename: todayFilename, Updated_At: getISTISOString(), Status: testStatus },
    ...existingRows,
  ];

  fs.writeFileSync(FILE_COVERAGE, [
    headers.join(','),
    ...coverageData.map(row =>
      [row.Date, row.Filename, row.Updated_At, row.Status].map(escapeCsvField).join(',')
    ),
  ].join('\n'));

  debugLog(`Coverage CSV updated at ${FILE_COVERAGE}`);
}

// Main function to fetch and cache data
async function fetchAndCacheData() {
  try {
    debugLog('Starting data fetch process');

    // Step 1: Generate access token
    const authToken = await generateAccessToken();

    // Step 2: Fetch live data
    const jsonData = await fetchLiveData(authToken);

    // Extract vehicle data from the JSON structure
    let rows = [];
    if (jsonData && jsonData.root && jsonData.root.VehicleData) {
      rows = jsonData.root.VehicleData;
      debugLog(`Parsed ${rows.length} fire truck records from JSON`);
    } else {
      debugLog('No vehicle data found in JSON response or unexpected JSON structure');
      debugLog('Full JSON response:', JSON.stringify(jsonData));
     }

    // Filter out rows with invalid coordinates
    const validRows = rows.filter(function(row) {
        row.Latitude = parseFloat(row.Latitude) || 0;
        row.Longitude = parseFloat(row.Longitude) || 0;

        // Check if we have valid coordinates
        if (!isValidGoaCoordinate(row.Latitude, 'lat') || !isValidGoaCoordinate(row.Longitude, 'lng')) {
          debugLog(`WARNING: Invalid coordinates for vehicle ${row.Vehicle_No}: ${row.Latitude}, ${row.Longitude}`);
        }
      return isValidGoaCoordinate(row.Latitude, 'lat') && isValidGoaCoordinate(row.Longitude, 'lng');
    });

    if (validRows.length < rows.length) {
      debugLog(`Filtered out ${rows.length - validRows.length} records with invalid coordinates`);
    }

    // Convert to GeoJSON
    const geojson = {
      type: 'FeatureCollection',
      features: validRows.map(row => {
        const { Latitude, Longitude, ...properties } = row;
        return {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [Longitude, Latitude]
          },
          properties
        };
      })
    };

    // Add metadata
    const result = {
      type: 'FeatureCollection',
      metadata: {
        timestamp: getISTISOString(),
        source: 'Directorate of Fire Emergency Services, Govt. of Goa',
        count: validRows.length
      },
      features: geojson.features
    };

    // Save to file
    debugLog(`Saving data to ${FILE_OUTPUT_JSON}...`);
    fs.writeFileSync(FILE_OUTPUT_JSON, JSON.stringify(result, null, 0));
    debugLog('Fire truck data cached successfully!');

    // Update daily GPX tracks
    const gpxFilePath = updateDailyGpxTracks(validRows);
    if (gpxFilePath) {
      debugLog(`Daily GPX tracks updated successfully at ${gpxFilePath}`);
    } else {
      debugLog('Failed to update daily GPX tracks');
    }

    // Update Daily CSV Log
    const csvFilePath = updateDailyCsvLog(validRows);
    debugLog(`Daily CSV log updated successfully at ${csvFilePath}`);

    // Update Coverage CSV
    // Get test status from env var or default to 'UNKNOWN'
    updateCoverageCsv(process.env.TEST_STATUS || 'UNKNOWN');

  } catch (error) {
    debugLog(`ERROR: ${error.message}`, error.stack);
    console.error('Error fetching or caching data:', error);

    // Even on error, we might want to update coverage if we can
    // timestamp is now
    // status is 'ERROR'
    // But we might typically want to do this only if we have a file to report on.
    // For now, let's leave it as is, or maybe update coverage with FAILING status?
    // Let's stick to the plan: if simple fetch fails, we exit(1).
    // The workflow can handle "NOT OK" if we want, but here we crash.

    process.exit(1);
  }
}

process.env.TZ = 'Asia/Kolkata';

// Make sure the cache directory exists
if (!fs.existsSync(DIRECTORY_CACHE)) {
  fs.mkdirSync(DIRECTORY_CACHE, { recursive: true });
}
if (!fs.existsSync(DIRECTORY_CSV)) {
  fs.mkdirSync(DIRECTORY_CSV, { recursive: true });
}

// Clear the debug log before starting
fs.writeFileSync(FILE_DEBUG_LOG, '');
debugLog('Debug logging initialized');

// Run only if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchAndCacheData();
}