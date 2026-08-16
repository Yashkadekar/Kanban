export const config = {
  runtime: 'edge', // Edge functions are fast and free on Vercel
};

export default async function handler(req) {
  // Verify cron secret if needed, but for simplicity let's just allow it
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY || !RESEND_API_KEY) {
    return new Response('Missing environment variables', { status: 500 });
  }

  try {
    // Fetch all boards that have a notification email
    const res = await fetch(`${SUPABASE_URL}/rest/v1/kanban_board?notification_email=not.is.null&select=board_key,notification_email,cards`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    });
    
    if (!res.ok) {
      throw new Error(`Failed to fetch boards: ${res.status}`);
    }

    const boards = await res.json();
    let emailsSent = 0;

    for (const board of boards) {
      let changed = false;
      const now = new Date();
      const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const updatedCards = board.cards.map(card => {
        if (!card.dueDate || card.notified) return card;

        const due = new Date(card.dueDate);
        // If due date is between now and 24 hours from now
        if (due > now && due <= next24h) {
          // Send email
          // We will push this to a promise array to send concurrently, or just await it here
          changed = true;
          card.notified = true;
        }
        return card;
      });

      if (changed) {
        // Send email (batching notifications per board is better)
        const dueCards = updatedCards.filter(c => c.notified && !board.cards.find(old => old.id === c.id).notified);
        
        if (dueCards.length > 0) {
          const emailBody = `
            <h2>Upcoming Deadlines on Kanban Board</h2>
            <p>You have ${dueCards.length} card(s) due in less than 24 hours:</p>
            <ul>
              ${dueCards.map(c => `<li><strong>${c.title}</strong> - Due: ${new Date(c.dueDate).toLocaleString()}</li>`).join('')}
            </ul>
            <p><a href="https://${req.headers.get('host')}/#${board.board_key}">View Board</a></p>
          `;

          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Kanban Alerts <onboarding@resend.dev>', // default resend testing domain
              to: board.notification_email,
              subject: `Reminder: ${dueCards.length} tasks due soon!`,
              html: emailBody
            })
          });
          
          emailsSent++;

          // Update board in Supabase to save the 'notified: true' state
          await fetch(`${SUPABASE_URL}/rest/v1/kanban_board?board_key=eq.${board.board_key}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ cards: updatedCards })
          });
        }
      }
    }

    return new Response(JSON.stringify({ success: true, emailsSent }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
