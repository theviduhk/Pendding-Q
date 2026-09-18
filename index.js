const axios = require("axios");

const BASE_URL = "https://monitor-public.trax-cloud.com";
const GRAFANA_URL = `${BASE_URL}/api/datasources/proxy/29/render`;

const USERNAME = "gss.kurunegala@gssintl.biz";
const PASSWORD = "Gssk@2021";

const FIREBASE_URL =
  "https://sahiru-7a8a4-default-rtdb.firebaseio.com/data.json";

const ALLOWED_TASKS = [
  "pricing_voting",
  "offline_pricing",
  "stitching",
  "masking",
  "masking_price_labels",
  "masking_engine"
];

let SESSION_ID = null;


// ========================================
// FORMAT DURATION
// ========================================

function formatDuration(seconds) {

  seconds = Number(seconds);

  if (isNaN(seconds)) {
    return null;
  }

  seconds = Math.floor(seconds);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (minutes < 60) {
    return `${minutes}m ${secs}s`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours < 24) {
    return `${hours}h ${mins}m`;
  }

  const days = Math.floor(hours / 24);
  const hrs = hours % 24;

  if (days < 7) {
    return `${days}d ${hrs}h`;
  }

  const weeks = Math.floor(days / 7);
  const remainingDays = days % 7;

  return `${weeks}w ${remainingDays}d`;
}


// ========================================
// LOGIN
// ========================================

async function login() {

  console.log("Logging into Grafana...");

  const res = await axios.post(
    `${BASE_URL}/login`,
    {
      user: USERNAME,
      password: PASSWORD
    },
    {
      maxRedirects: 0,
      validateStatus: status => status < 500
    }
  );

  const cookies = res.headers["set-cookie"];

  if (!cookies) {
    throw new Error("Login failed. No cookies returned.");
  }

  const sessionCookie = cookies.find(c =>
    c.startsWith("grafana_session=")
  );

  if (!sessionCookie) {
    throw new Error("grafana_session cookie not found.");
  }

  SESSION_ID = sessionCookie
    .split(";")[0]
    .replace("grafana_session=", "");

  console.log("New Session created");
}


// ========================================
// FETCH GRAFANA
// ========================================

async function fetchGrafana() {

  if (!SESSION_ID) {
    await login();
  }

  // Get BOTH total and oldestTask
  const payload =
    "target=prod.gauges.selector.queue.*.*.total" +
    "&target=prod.gauges.selector.queue.*.*.oldestTask" +
    "&from=-1h&until=now&format=json";

  try {

    const res = await axios.post(
      GRAFANA_URL,
      payload,
      {
        headers: {
          Cookie: `grafana_session=${SESSION_ID}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    return res.data;

  } catch (err) {

    // Session expired
    if (
      err.response &&
      (err.response.status === 401 ||
       err.response.status === 403)
    ) {

      console.log("Session expired. Logging in again...");

      await login();

      const retry = await axios.post(
        GRAFANA_URL,
        payload,
        {
          headers: {
            Cookie: `grafana_session=${SESSION_ID}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0"
          }
        }
      );

      return retry.data;
    }

    throw err;
  }
}


// ========================================
// FETCH + FIREBASE
// ========================================

async function fetchAndPush() {

  try {

    const data = await fetchGrafana();

    // project + task එකකට එක object එකක්
    const grouped = {};

    data.forEach(series => {

      const parts = series.target.split(".");

      /*
        Example:

        prod.gauges.selector.queue.stitching.marsbh.total

        parts:

        0 = prod
        1 = gauges
        2 = selector
        3 = queue
        4 = stitching
        5 = marsbh
        6 = total
      */

      if (parts.length < 7) {
        return;
      }

      const task = parts[4];
      const project = parts[5];
      const type = parts[6];

      // Ignore sand projects
      if (project.includes("-sand")) {
        return;
      }

      // Only allowed tasks
      if (!ALLOWED_TASKS.includes(task)) {
        return;
      }

      // Valid datapoints
      const validPoints =
        series.datapoints?.filter(dp => dp[0] !== null);

      if (!validPoints?.length) {
        return;
      }

      const lastPoint =
        validPoints[validPoints.length - 1];

      const value = Number(lastPoint[0]);

      const key = `${project}_${task}`;

      if (!grouped[key]) {

        grouped[key] = {
          project,
          task,
          value: null,

          // Raw duration seconds
          durationRaw: null,

          // Human readable duration
          duration: null,

          lastUpdated: new Date().toISOString()
        };
      }


      // ========================================
      // TOTAL
      // ========================================

      if (type === "total") {

        grouped[key].value = value;
      }


      // ========================================
      // OLDEST TASK / DURATION
      // ========================================

      if (type === "oldestTask") {

        grouped[key].durationRaw = value;

        grouped[key].duration =
          formatDuration(value);
      }

    });


    // Convert object -> array
    const output = Object.values(grouped);


    // Sort by queue value
    output.sort((a, b) =>
      (b.value || 0) - (a.value || 0)
    );


    // ========================================
    // FIREBASE
    // ========================================

    await axios.put(
      FIREBASE_URL,
      output
    );


    console.log(
      `Updated Firebase (${output.length} records)`,
      new Date().toLocaleTimeString()
    );


    // ========================================
    // CONSOLE PREVIEW
    // ========================================

    console.log("\n------------------------------");
    console.log("GRAFANA DATA");
    console.log("------------------------------");

    output.slice(0, 10).forEach(item => {

      console.log(
        `${item.project} | ` +
        `${item.task} | ` +
        `Queue: ${item.value} | ` +
        `Duration: ${item.duration} | ` +
        `Raw: ${item.durationRaw}`
      );

    });

    console.log("------------------------------\n");


  } catch (err) {

    console.error(
      err.response?.status,
      err.message
    );

  }
}


// ========================================
// START
// ========================================

fetchAndPush();

setInterval(
  fetchAndPush,
  30000
);
