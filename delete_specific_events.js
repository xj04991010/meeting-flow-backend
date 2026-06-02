const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const dotenv = require('dotenv');

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const TARGET_TITLES = [
  "自慰",
  "遛狗",
  "168",
  "減脂",
  "蛋白質"
];

async function deleteAllCalendarsEvents() {
  const { data: tokenData } = await supabase
    .from('google_tokens')
    .select('*')
    .limit(1)
    .single();

  if (!tokenData) return;

  const authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  authClient.setCredentials({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry_date: tokenData.expiry_date ? new Date(tokenData.expiry_date).getTime() : null
  });

  const calendar = google.calendar({ version: 'v3', auth: authClient });

  console.log('Fetching all calendar lists...');
  const calendarList = await calendar.calendarList.list();
  
  if (!calendarList.data.items) {
    console.log('No calendars found.');
    return;
  }

  let totalDeleted = 0;

  for (const cal of calendarList.data.items) {
    console.log(`\nSearching in calendar: ${cal.summary} (${cal.id})`);
    
    for (const target of TARGET_TITLES) {
      let pageToken = null;
      do {
        try {
          const res = await calendar.events.list({
            calendarId: cal.id,
            q: target,
            maxResults: 2500,
            singleEvents: true,
            pageToken: pageToken
          });

          const events = res.data.items;
          if (events && events.length > 0) {
            for (const event of events) {
              console.log(`Found event to delete: ${event.summary} (${event.start?.dateTime || event.start?.date})`);
              try {
                await calendar.events.delete({
                  calendarId: cal.id,
                  eventId: event.id
                });
                totalDeleted++;
                console.log(` -> Deleted.`);
              } catch (e) {
                console.error(` -> Failed to delete:`, e.message);
              }
            }
          }
          pageToken = res.data.nextPageToken;
        } catch(e) {
          console.error(`Error searching calendar ${cal.summary}: ${e.message}`);
          break;
        }
      } while (pageToken);
    }
  }

  console.log(`\nFinished. Total deleted across all calendars: ${totalDeleted} events.`);
}

deleteAllCalendarsEvents().catch(console.error);
