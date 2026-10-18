# Dincharya (दिनचर्या)

**Say what you're doing. Dincharya keeps your day.**

*Dincharya (दिनचर्या) means "daily routine" in Hindi.*

A voice-first log of your day. Speak naturally, in English, Hindi, Hinglish or any Indian language, and Dincharya turns it into a timeline you can look back on, day by day.

## What you can say

| You say | Dincharya records |
|---|---|
| "Taking a break for half an hour" | Break, now → 30 min from now, with a countdown |
| "Ab 3 ghante DSA karungi" | DSA practice, now → 3 hours from now |
| "Lunch kar rahi hoon" | Lunch from now, until you start the next thing |
| "2 se 5 tak project pe kaam kiya" | Project work, 2:00–5:00 pm |
| "Subah 7 se 8 gym, phir 8:30 tak nashta" | Gym 7–8, breakfast 8–8:30 |
| "Kal raat 11 se 7 tak soyi" | Sleep, last night 11 pm → 7 am |
| "Done" / "break khatam" | Ends whatever is running |

## Features

- **Right now card:** what you're doing, with a live timer or countdown. When a break runs out, it chimes and offers **Back to DSA** (whatever the break interrupted).
- **Day timeline:** every activity with times and durations, gaps you didn't log, and time per type (study, work, meals, breaks, sleep…). Go back to any date.
- **Summarise this day:** a short spoken review of your day with one suggestion for tomorrow.
- **Edit anything, undo anything:** tap an activity to fix it, or undo the last change.
- **Never lose your log:** saved instantly in the browser (works offline), and backed up to a Postgres database and synced across your phone and laptop with a passcode.
- **Replies in 11 languages:** English, Hindi, Bengali, Marathi, Tamil, Telugu, Kannada, Malayalam, Gujarati, Punjabi, Odia.

## Sarvam AI models used

| Model | Used for |
|---|---|
| Saaras v4 | Speech to text, auto-detecting the language |
| Sarvam 105B | Turning sentences into activities and times; writing the day summary |
| Bulbul v3 | Speaking replies and summaries |

## Run locally

```bash
npm install
cp .env.example .env      # add SARVAM_API_KEY; DATABASE_URL and SYNC_PASSCODE for sync
npm start
```

Open http://localhost:3000. Without `DATABASE_URL`, Dincharya still works and keeps the log in the browser.
