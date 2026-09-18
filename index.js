const axios = require("axios");

const BASE_URL = "https://monitor-public.trax-cloud.com";
const GRAFANA_URL = `${BASE_URL}/api/datasources/proxy/29/render`;

const USERNAME = "gss.kurunegala@gssintl.biz";
const PASSWORD = "Gssk@2021";

const FIREBASE_BASE_URL =
  "https://sahiru-7a8a4-default-rtdb.firebaseio.com/data";

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
// FIREBASE KEY SAFE FORMAT
// ======================================================

function firebaseKey(project, task) {

  return `${project}_${task}`
    .replace(/[.#$[\]/]/g, "_");
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

  console.log("✅ Grafana session created");
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

    total + oldestTask are requested
    in the SAME Grafana request.

    Therefore:

    value
    durationRaw
    duration

    are generated from the same fetch cycle.
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
          "Content-Type":
            "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0"
        }
      }
    );

    return res.data;

  } catch (err) {

    if (
      err.response &&
      (
        err.response.status === 401 ||
        err.response.status === 403
      )
    ) {

      console.log(
        "🔄 Grafana session expired. Re-login..."
      );

      await login();

      const retry = await axios.post(
        GRAFANA_URL,
        payload,
        {
          headers: {
            Cookie:
              `grafana_session=${SESSION_ID}`,
            "Content-Type":
              "application/x-www-form-urlencoded",
            "User-Agent":
              "Mozilla/5.0"
          }
        }
      );

      return retry.data;
    }

    throw err;
  }
}


// ======================================================
// GET LAST VALID VALUE
// ======================================================

function getLastValue(series) {

  if (
    !series ||
    !Array.isArray(series.datapoints)
  ) {
    return null;
  }

  const validPoints =
    series.datapoints.filter(
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
// GET EXISTING FIREBASE DATA
// ======================================================

async function getFirebaseData() {

  try {

    const res =
      await axios.get(
        `${FIREBASE_BASE_URL}.json`
      );

    return res.data || {};

  } catch (err) {

    console.log(
      "⚠️ Firebase read error:",
      err.message
    );

    return {};
  }
}


// ======================================================
// MAIN FETCH + UPDATE
// ======================================================

async function fetchAndPush() {

  try {

    console.log("");
    console.log("======================================");
    console.log("🚀 GRAFANA UPDATE");
    console.log(
      new Date().toLocaleTimeString()
    );
    console.log("======================================");


    // ==================================================
    // GET EXISTING FIREBASE
    // ==================================================

    const existingData =
      await getFirebaseData();


    // ==================================================
    // GET GRAFANA
    // ==================================================

    const grafanaData =
      await fetchGrafana();


    // ==================================================
    // TEMP STORAGE
    // ==================================================

    const records = {};


    // ==================================================
    // PROCESS ALL GRAFANA SERIES
    // ==================================================

    grafanaData.forEach(series => {

      if (!series?.target) {
        return;
      }


      const parts =
        series.target.split(".");


      /*
        Example:

        prod.gauges.selector.queue.stitching.marsbh.total

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
      if (
        project.includes("-sand")
      ) {
        return;
      }


      // Allowed tasks only
      if (
        !ALLOWED_TASKS.includes(task)
      ) {
        return;
      }


      const last =
        getLastValue(series);


      if (!last) {
        return;
      }


      const key =
        firebaseKey(
          project,
          task
        );


      // ==================================================
      // CREATE RECORD
      // ==================================================

      if (!records[key]) {

        records[key] = {

          project,
          task,

          value: null,

          durationRaw: null,

          duration: null,

          lastUpdated: null
        };
      }


      // ==================================================
      // TOTAL VALUE
      // ==================================================

      if (type === "total") {

        records[key].value =
          last.value;
      }


      // ==================================================
      // DURATION
      // ==================================================

      if (
        type === "oldestTask"
      ) {

        records[key].durationRaw =
          last.value;

        records[key].duration =
          formatDuration(
            last.value
          );
      }


      records[key].lastUpdated =
        new Date().toISOString();

    });


    // ==================================================
    // PREPARE FIREBASE PATCH
    // ==================================================

    const updates = {};


    Object.entries(records).forEach(
      ([key, newRecord]) => {

        const oldRecord =
          existingData[key] || {};


        /*
          IMPORTANT:

          If Grafana returns BOTH:

          value
          durationRaw
          duration

          all three are updated together.

          If one is temporarily missing,
          old value is preserved.

          NOTHING IS DELETED.
        */

        const finalRecord = {

          project:
            newRecord.project ??
            oldRecord.project ??
            null,

          task:
            newRecord.task ??
            oldRecord.task ??
            null,

          value:
            newRecord.value !== null
              ? newRecord.value
              : (
                  oldRecord.value ??
                  null
                ),

          durationRaw:
            newRecord.durationRaw !== null
              ? newRecord.durationRaw
              : (
                  oldRecord.durationRaw ??
                  null
                ),

          duration:
            newRecord.duration !== null
              ? newRecord.duration
              : (
                  oldRecord.duration ??
                  null
                ),

          lastUpdated:
            newRecord.lastUpdated ??
            oldRecord.lastUpdated ??
            new Date().toISOString()
        };


        // ==================================================
        // UPDATE ONLY WHEN SOMETHING CHANGED
        // ==================================================

        const changed =
          JSON.stringify(finalRecord) !==
          JSON.stringify(oldRecord);


        if (changed) {

          updates[key] =
            finalRecord;

          console.log(
            `🔄 ${newRecord.project} | ` +
            `${newRecord.task} | ` +
            `Queue: ${finalRecord.value} | ` +
            `Duration: ${finalRecord.duration}`
          );

        } else {

          console.log(
            `⏭️ ${newRecord.project} | ` +
            `${newRecord.task} | No change`
          );

        }

      }
    );


    // ==================================================
    // FIREBASE PATCH
    // ==================================================

    if (
      Object.keys(updates).length > 0
    ) {

      await axios.patch(
        `${FIREBASE_BASE_URL}.json`,
        updates,
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );


      console.log(
        `🚀 Firebase updated: ` +
        `${Object.keys(updates).length} records`
      );

    } else {

      console.log(
        "✅ No changes detected"
      );

    }


    console.log(
      "======================================"
    );

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

console.log("");
console.log("======================================");
console.log("🚀 Grafana → Firebase Monitor");
console.log("⏱️ Update: Every 30 seconds");
console.log("======================================");


fetchAndPush();


setInterval(
  fetchAndPush,
  30000
);
