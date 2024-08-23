const express = require("express");
const session = require("express-session");
const { google } = require("googleapis");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const { Client, ID, Databases } = require("node-appwrite");
require("dotenv").config();

const credentials = require("./creds.json");
const { fitness } = require("googleapis/build/src/apis/fitness");

const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

const client = new Client();

client
  .setEndpoint("https://cloud.appwrite.io/v1")
  .setProject(process.env.PROJECT_ID)
  .setKey(process.env.API_KEY);

const database = new Databases(client);

const SCOPES = [
  "https://www.googleapis.com/auth/fitness.activity.read",
  "https://www.googleapis.com/auth/fitness.blood_glucose.read",
  "https://www.googleapis.com/auth/fitness.blood_pressure.read",
  "https://www.googleapis.com/auth/fitness.heart_rate.read",
  "https://www.googleapis.com/auth/fitness.body.read",
  "https://www.googleapis.com/auth/fitness.body.read",
  "https://www.googleapis.com/auth/fitness.sleep.read",
  "https://www.googleapis.com/auth/fitness.body.read",
  "https://www.googleapis.com/auth/fitness.reproductive_health.read",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const secretKey = crypto.randomBytes(32).toString("hex");

const app = express();
app.use(
  cors({
    origin: "https://3000-krushna06-fitnessapi-say3oseu5h3.ws-us115.gitpod.io",
  })
);

app.use(
  session({
    secret: secretKey,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // true if using HTTPS
  })
);

let userProfileData;
async function getUserProfile(auth) {
  const service = google.people({ version: "v1", auth });
  const profile = await service.people.get({
    resourceName: "people/me",
    personFields: "names,photos,emailAddresses",
  });

  const displayName = profile.data.names[0].displayName;
  const url = profile.data.photos[0].url;
  let userID = profile.data.resourceName;
  userID = parseInt(userID.replace("people/", ""), 10);
  return {
    displayName,
    profilePhotoUrl: url,
    userID,
  };
}

app.get("/auth/google", (req, res) => {
  console.log("Auth route hit!");

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  res.json({ authUrl });
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    req.session.tokens = tokens;

    const profile = await getUserProfile(oAuth2Client);

    // Save user profile data in the session
    req.session.userProfile = profile;
    userProfileData = profile;

    // Debugging logs
    console.log("User Profile Data:", profile);

    res.redirect("/fetch-data");
  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.redirect("/error");
  }
});

let isSecondHit = false;
app.get("/fetch-data", async (req, res) => {
  try {
    const userProfile = req.session.userProfile;

    if (!userProfile) {
      return res.status(400).json({ error: "User is not authenticated" });
    }

    const fitness = google.fitness({
      version: "v1",
      auth: oAuth2Client,
    });

    const userName = userProfile.displayName;
    const profilePhoto = userProfile.profilePhotoUrl;
    const userId = userProfile.userID;

    const sevenDaysInMillis = 14 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    const startTimeMillis = Date.now() - sevenDaysInMillis; // Start time is 7 days ago
    const endTimeMillis = Date.now() + 24 * 60 * 60 * 1000; // End time is the current time

    const response = await fitness.users.dataset.aggregate({
      userId: "me",
      requestBody: {
        aggregateBy: [
          {
            dataTypeName: "com.google.step_count.delta",
          },
          {
            dataTypeName: "com.google.blood_glucose",
          },
          {
            dataTypeName: "com.google.blood_pressure",
          },
          {
            dataTypeName: "com.google.heart_rate.bpm",
          },
          {
            dataTypeName: "com.google.weight",
          },
          {
            dataTypeName: "com.google.height",
          },
          {
            dataTypeName: "com.google.sleep.segment",
          },
          {
            dataTypeName: "com.google.body.fat.percentage",
          },
        ],
        bucketByTime: { durationMillis: 86400000 }, // Aggregate data in daily buckets
        startTimeMillis,
        endTimeMillis,
      },
    });

    console.log("Raw API Response:", JSON.stringify(response.data, null, 2)); // Log raw response for debugging

    const fitnessData = response.data.bucket;
    const formattedData = [];

    fitnessData.map((data) => {
      const date = new Date(parseInt(data.startTimeMillis));
      const formattedDate = date.toDateString();

      const formattedEntry = {
        date: formattedDate,
        step_count: 0,
        glucose_level: 0,
        blood_pressure: [],
        heart_rate: 0,
        weight: 0,
        height_in_cms: 0,
        sleep_hours: 0,
        body_fat_in_percent: 0,
      };

      const datasetMap = data.dataset;
      datasetMap.map((mydataset) => {
        const point = mydataset.point;
        if (point && point.length > 0) {
          const value = point[0].value;
          switch (mydataset.dataSourceId) {
            case "derived:com.google.step_count.delta:com.google.android.gms:aggregated":
              formattedEntry.step_count = value[0]?.intVal || 0;
              break;
            case "derived:com.google.blood_glucose.summary:com.google.android.gms:aggregated":
              let glucoseLevel = 0;
              if (mydataset.point[0]?.value) {
                if (mydataset.point[0]?.value.length > 0) {
                  const dataArray = mydataset.point[0]?.value;
                  dataArray.map((data) => {
                    if (data.fpVal) {
                      glucoseLevel = data.fpVal * 10;
                    }
                  });
                }
              }
              formattedEntry.glucose_level = glucoseLevel;
              break;
            case "derived:com.google.blood_pressure.summary:com.google.android.gms:aggregated":
              let finalData = [0, 0];
              if (mydataset.point[0]?.value) {
                const BParray = mydataset.point[0]?.value;
                if (BParray.length > 0) {
                  BParray.map((data) => {
                    if (data.fpVal) {
                      if (data.fpVal > 100) {
                        finalData[0] = data.fpVal;
                      } else if (data.fpVal < 100) {
                        finalData[1] = data.fpVal;
                      }
                    }
                  });
                }
              }
              formattedEntry.blood_pressure = finalData;
              break;
            case "derived:com.google.heart_rate.summary:com.google.android.gms:aggregated":
              let heartData = 0;
              if (mydataset.point[0]?.value) {
                if (mydataset.point[0]?.value.length > 0) {
                  const heartArray = mydataset.point[0]?.value;
                  heartArray.map((data) => {
                    if (data.fpVal) {
                      heartData = data.fpVal;
                    }
                  });
                }
              }
              formattedEntry.heart_rate = heartData;
              break;
            case "derived:com.google.weight.summary:com.google.android.gms:aggregated":
              formattedEntry.weight = value[0]?.fpVal || 0;
              break;
            case "derived:com.google.height.summary:com.google.android.gms:aggregated":
              formattedEntry.height_in_cms = value[0]?.fpVal * 100 || 0;
              break;
            case "derived:com.google.sleep.segment:com.google.android.gms:merged":
              formattedEntry.sleep_hours = mydataset.point[0]?.value || 0;
              break;
            case "derived:com.google.body.fat.percentage.summary:com.google.android.gms:aggregated":
              let bodyFat = 0;
              if (mydataset.point[0]?.value) {
                if (mydataset.point[0]?.value.length > 0) {
                  bodyFat = mydataset.point[0].value[0].fpVal;
                }
              }
              formattedEntry.body_fat_in_percent = bodyFat;
              break;
          }
        }
      });

      formattedData.push(formattedEntry);
    });

    console.log("User Name:", userName);
    console.log("Profile Photo URL:", profilePhoto);
    console.log("User ID:", userId);
    console.log("Fitness Data:", formattedData);

    res.status(200).json({ userName, profilePhoto, userId, formattedData });
  } catch (error) {
    console.error("Error fetching fitness data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


app.use(express.static(path.join(__dirname)));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
