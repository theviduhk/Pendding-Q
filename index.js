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

// Login and get grafana_session cookie
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

  console.log("New Session:", SESSION_ID);
}

async function fetchGrafana() {
  if (!SESSION_ID) {
    await login();
  }

  try {
    const res = await axios.post(
      GRAFANA_URL,
      "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json",
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
      (err.response.status === 401 || err.response.status === 403)
    ) {

      console.log("Session expired. Logging in again...");

      await login();

      const retry = await axios.post(
        GRAFANA_URL,
        "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json",
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

async function fetchAndPush() {
  try {

    const data = await fetchGrafana();

    let output = [];

    data.forEach(series => {

      const parts = series.target.split(".");

      if (parts.length < 6) return;

      const task = parts[4];
      const project = parts[5];

      if (project.includes("-sand")) return;

      if (!ALLOWED_TASKS.includes(task)) return;

      const validPoints = series.datapoints.filter(dp => dp[0] !== null);

      if (!validPoints.length) return;

      output.push({
        project,
        task,
        value: validPoints[validPoints.length - 1][0]
      });

    });

    output.sort((a, b) => b.value - a.value);

    await axios.put(FIREBASE_URL, output);

    console.log(
      `Updated Firebase (${output.length} records)`,
      new Date().toLocaleTimeString()
    );

  } catch (err) {

    console.error(err.response?.status, err.message);

  }
}

fetchAndPush();
setInterval(fetchAndPush, 30000);
