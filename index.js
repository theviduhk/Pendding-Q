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


// ======================================================
// FORMAT DURATION
// ======================================================

function formatDuration(seconds) {

  seconds = Number(seconds);

  if (!Number.isFinite(seconds)) {
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


// ======================================================
// LOGIN
// ======================================================

async function login() {

  console.log("🔐 Logging into Grafana...");

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

  console.log("✅ New Grafana session created");
}


// ======================================================
// FETCH GRAFANA
// ======================================================

async function fetchGrafana() {

  if (!SESSION_ID) {
    await login();
  }

  /*
    IMPORTANT:

    Both requests are sent together.

    1. total
    2. oldestTask

    So both values belong to the same Grafana request.
  */

  const payload =
    "target=prod.gauges.selector.queue.*.*.total" +
    "&target=prod.gauges.selector.queue.*.*.oldestTask" +
    "&from=-1h" +
    "&until=now" +
    "&format=json";


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

    // ==================================================
    // SESSION EXPIRED
    // ==================================================

    if (
      err.response &&
      (
        err.response.status === 401 ||
        err.response.status === 403
      )
    ) {

      console.log(
        "🔄 Session expired. Logging in again..."
      );

      await login();

      const retry = await axios.post(
        GRAFANA_URL,
        payload,
        {
          headers: {
            Cookie: `grafana_session=${SESSION_ID}`,
            "Content-Type":
              "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0"
          }
        }
      );

      return retry.data;
    }

    throw err;
  }
}


// ======================================================
// GET LAST VALID DATAPOINT
// ======================================================

function getLastValue(series) {

  if (!series || !Array.isArray(series.datapoints)) {
    return null;
  }

  const validPoints = series.datapoints.filter(
    dp =>
      Array.isArray(dp) &&
      dp[0] !== null &&
      dp[0] !== undefined
  );

  if (!validPoints.length) {
    return null;
  }

  const last =
    validPoints[validPoints.length - 1];

  return {
    value: Number(last[0]),
    timestamp: last[1]
  };
}


// ======================================================
// FETCH EXISTING FIREBASE DATA
// ======================================================

async function getExistingFirebaseData() {

  try {

    const res = await axios.get(FIREBASE_URL);

    if (!res.data) {
      return [];
    }

    return Array.isArray(res.data)
      ? res.data
      : Object.values(res.data);

  } catch (err) {

    console.log(
      "⚠️ Could not read existing Firebase data:",
      err.message
    );

    return [];
  }
}


// ======================================================
// MAIN
// ======================================================

async function fetchAndPush() {

  try {

    console.log("\n");
    console.log("==============================================");
    console.log("🚀 Fetching Grafana");
    console.log(new Date().toLocaleString());
    console.log("==============================================");


    // ==================================================
    // GET EXISTING DATA FIRST
    // ==================================================

    const existingData =
      await getExistingFirebaseData();


    // ==================================================
    // GET GRAFANA DATA
    // ==================================================

    const data =
      await fetchGrafana();


    // ==================================================
    // TEMP STORAGE
    // ==================================================

    const grouped = {};


    // ==================================================
    // PROCESS GRAFANA SERIES
    // ==================================================

    data.forEach(series => {

      if (!series || !series.target) {
        return;
      }


      const parts =
        series.target.split(".");


      /*
        Expected:

        prod
        gauges
        selector
        queue
        TASK
        PROJECT
        TYPE

        Example:

        prod.gauges.selector.queue.stitching.marsbh.total

        parts[4] = stitching
        parts[5] = marsbh
        parts[6] = total
      */


      if (parts.length < 7) {
        return;
      }


      const task = parts[4];
      const project = parts[5];
      const type = parts[6];


      // ==================================================
      // FILTER PROJECT
      // ==================================================

      if (project.includes("-sand")) {
        return;
      }


      // ==================================================
      // FILTER TASK
      // ==================================================

      if (!ALLOWED_TASKS.includes(task)) {
        return;
      }


      // ==================================================
      // GET LAST VALUE
      // ==================================================

      const last =
        getLastValue(series);


      if (!last) {
        return;
      }


      const key =
        `${project}|||${task}`;


      // ==================================================
      // CREATE RECORD
      // ==================================================

      if (!grouped[key]) {

        grouped[key] = {

          project,
          task,

          value: null,

          durationRaw: null,

          duration: null,

          lastUpdated: null,

          totalTimestamp: null,

          durationTimestamp: null
        };
      }


      // ==================================================
      // TOTAL
      // ==================================================

      if (type === "total") {

        grouped[key].value =
          last.value;

        grouped[key].totalTimestamp =
          last.timestamp;
      }


      // ==================================================
      // OLDEST TASK
      // ==================================================

      if (type === "oldestTask") {

        grouped[key].durationRaw =
          last.value;

        grouped[key].duration =
          formatDuration(last.value);

        grouped[key].durationTimestamp =
          last.timestamp;
      }

    });


    // ==================================================
    // MERGE WITH EXISTING DATA
    // ==================================================

    const existingMap = {};


    existingData.forEach(item => {

      if (
        item &&
        item.project &&
        item.task
      ) {

        const key =
          `${item.project}|||${item.task}`;

        existingMap[key] = item;
      }

    });


    // ==================================================
    // FINAL OUTPUT
    // ==================================================

    const output = [];


    Object.keys(grouped).forEach(key => {

      const newItem =
        grouped[key];

      const oldItem =
        existingMap[key] || {};


      /*
        IMPORTANT:

        Both value and duration are merged
        into ONE record.

        If Grafana returned both:
          → update both.

        If only value came:
          → keep old duration.

        If only duration came:
          → keep old value.
      */


      const finalItem = {

        project: newItem.project,

        task: newItem.task,

        value:
          newItem.value !== null
            ? newItem.value
            : oldItem.value ?? null,

        durationRaw:
          newItem.durationRaw !== null
            ? newItem.durationRaw
            : oldItem.durationRaw ?? null,

        duration:
          newItem.duration !== null
            ? newItem.duration
            : oldItem.duration ?? null,

        lastUpdated:
          new Date().toISOString(),

        totalTimestamp:
          newItem.totalTimestamp ??
          oldItem.totalTimestamp ??
          null,

        durationTimestamp:
          newItem.durationTimestamp ??
          oldItem.durationTimestamp ??
          null
      };


      output.push(finalItem);

    });


    // ==================================================
    // KEEP OLD RECORDS THAT DID NOT APPEAR THIS TIME
    // ==================================================

    existingData.forEach(oldItem => {

      if (
        !oldItem ||
        !oldItem.project ||
        !oldItem.task
      ) {
        return;
      }


      const key =
        `${oldItem.project}|||${oldItem.task}`;


      if (!grouped[key]) {

        output.push(oldItem);

      }

    });


    // ==================================================
    // SORT BY QUEUE
    // ==================================================

    output.sort(
      (a, b) =>
        (Number(b.value) || 0) -
        (Number(a.value) || 0)
    );


    // ==================================================
    // FIREBASE UPDATE
    // ==================================================

    await axios.put(
      FIREBASE_URL,
      output,
      {
        headers: {
          "Content-Type":
            "application/json"
        }
      }
    );


    // ==================================================
    // LOG
    // ==================================================

    console.log(
      `✅ Firebase updated: ${output.length} records`
    );


    console.log(
      `⏰ ${new Date().toLocaleTimeString()}`
    );


    // ==================================================
    // PREVIEW
    // ==================================================

    console.log("\n📊 DATA PREVIEW");
    console.log("----------------------------------------------");


    output.slice(0, 20).forEach(item => {

      console.log(
        `${item.project.padEnd(20)} | ` +
        `${item.task.padEnd(22)} | ` +
        `Queue: ${String(item.value).padEnd(6)} | ` +
        `Duration: ${item.duration}`
      );

    });


    console.log("----------------------------------------------");

  } catch (err) {

    console.error(
      "❌ ERROR:",
      err.response?.status || "",
      err.message
    );

  }
}


// ======================================================
// START
// ======================================================

console.log("==============================================");
console.log("🚀 Grafana → Firebase Monitor Started");
console.log("⏱️ Update interval: 30 seconds");
console.log("==============================================");


fetchAndPush();


setInterval(
  fetchAndPush,
  30000
);
