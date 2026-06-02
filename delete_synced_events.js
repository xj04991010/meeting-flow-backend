const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

async function deleteSyncedEvents() {
  console.log('Fetching synced events from MeetingFlow database...');
  const { data: intents, error } = await supabase
    .from('calendar_intents')
    .select('*')
    .eq('sync_status', 'synced')
    .not('external_calendar_id', 'is', null);

  if (error) {
    console.error('Error fetching intents:', error);
    return;
  }

  if (!intents || intents.length === 0) {
    console.log('No synced events found to delete.');
    return;
  }

  console.log(`Found ${intents.length} synced events. Processing...`);

  for (const intent of intents) {
    console.log(`Deleting event: ${intent.title} (${intent.external_calendar_id})`);
    
    // Get token for the specific user
    const { data: tokenData } = await supabase
      .from('google_tokens')
      .select('*')
      .eq('user_id', intent.user_id)
      .single();

    if (!tokenData) {
      console.error(`No Google token found for user ${intent.user_id}. Skipping.`);
      continue;
    }

    const authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    authClient.setCredentials({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expiry_date: tokenData.expiry_date ? new Date(tokenData.expiry_date).getTime() : null
    });

    const calendar = google.calendar({ version: 'v3', auth: authClient });

    try {
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: intent.external_calendar_id
      });
      console.log('Successfully deleted from Google Calendar.');
      
      // Update DB to clear the sync status
      await supabase.from('calendar_intents').update({
        sync_status: 'ready',
        external_calendar_id: null,
        synced_at: null
      }).eq('id', intent.id);
      
      console.log('Database updated.');
    } catch (e) {
      console.error(`Failed to delete event ${intent.external_calendar_id}:`, e.message);
      // Sometimes it's already deleted manually by the user
      if (e.message.includes('Not Found') || e.message.includes('Gone')) {
        await supabase.from('calendar_intents').update({
          sync_status: 'ready',
          external_calendar_id: null,
          synced_at: null
        }).eq('id', intent.id);
        console.log('Event was already missing from Google. DB updated anyway.');
      }
    }
  }
}

deleteSyncedEvents().catch(console.error);
