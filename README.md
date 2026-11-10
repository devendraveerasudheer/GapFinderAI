# GapFinder AI

GapFinder turns study materials into source-grounded explanations, diagnostic quizzes, topic-level gap reports, and revision plans. The Python server provides shared student accounts, persistent workspaces, and an admin activity dashboard.

## Set up and run

1. Install Python 3.10 or later.
2. Create `.env` from the example only if you do not already have one, then edit it locally:

   ```powershell
   if (!(Test-Path .env)) { Copy-Item .env.example .env }
   notepad .env
   ```

   If `.env` already exists, do not overwrite it; add or edit the needed settings in that file so your existing Groq key is preserved.
3. Configure `GROQ_API_KEY`, `ADMIN_EMAIL`, and a unique `ADMIN_PASSWORD` (at least 12 characters). The admin account is provisioned from server configuration; there is no hard-coded admin credential. Optionally adjust `GROQ_MODEL`. Keep the admin password private and do not send it in chat.
4. Start from the project folder:

   ```powershell
   .\start.ps1
   ```

5. Open the local URL printed by the server, normally `http://127.0.0.1:8000`. Keep the server running.

Students register with their own email and password. They must acknowledge the activity notice before registration.

## Admin sign-in

On the login page, select **Admin**, then enter the email and password set as `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your local `.env` file. For example, the configuration uses this shape:

```dotenv
ADMIN_EMAIL= admin@gmail.com
ADMIN_PASSWORD= admin123456789
```

These are placeholders, not working credentials. Use the values you configured locally. Do not put a real admin password in this README or commit it to source control; `.env` is ignored by Git.

The SQLite database is stored in `gapfinder.sqlite3`; it is ignored by Git and should be backed up securely. Student workspaces persist on the server for their own accounts. Activity events are automatically deleted after 10 days.

## Admin activity and student privacy

The admin dashboard at **Student activity** shows the last login, number of logins, active time on study pages, quiz count and scores, and topic-level quiz results. The admin API does not expose student chat messages, quiz answer text, uploaded materials, or file names.

Students see the exact activity scope before they create an account and a reminder while signed in. Time is counted while the browser tab is visible and reported in short intervals. The dashboard is intended for learning support, not covert surveillance.

By default, the server only listens on the local computer. To let devices on a trusted local network connect, set `SERVER_HOST=0.0.0.0` and add the server's IP/hostname to `ALLOWED_HOSTS`. For example:

```text
SERVER_HOST=0.0.0.0
ALLOWED_HOSTS=localhost,127.0.0.1,192.168.1.25
```

Do not expose the development server directly to the public internet. Remote deployment requires HTTPS, `COOKIE_SECURE=1`, restricted registration, firewalling, and production-grade security review.

## Features

- Upload text, Markdown, and text-based PDF syllabi, notes, and past papers. PDF text is extracted in the browser; scanned PDFs are not OCR'd.
- Chunk and retrieve source passages on the server, retaining material, section, and page citations.
- Use Groq to generate source-grounded explanations and quizzes, and evaluate answers against retrieved passages.
- Update topic mastery and revision priorities from quiz scores.
- Keep each student's server-backed workspace private to that student; authorized admin reports contain only the disclosed activity summary.

## Retrieval, generation, and evaluation

**Retrieval** chunks materials and ranks passages against a question or topic. **Generation** sends only retrieved excerpts to Groq with instructions to cite evidence and abstain when unsupported. **Evaluation** sends an answer, its rubric, and its source passage to Groq, then constrains scores and gap labels to the generated rubric. The API key remains on the server.

Chat content and uploaded document text are sent to Groq when students use AI features, but are not included in the admin activity report. Do not upload sensitive information.

## Tests

```powershell
python -m unittest -v
```

Tests use a temporary SQLite database and mock Groq; they do not require a live API key.
