# All-in-One Assistant — Bot specification

**Archetype:** custom

**Voice:** friendly and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot that answers questions, generates images, creates documents (PDF/DOCX/TXT), and converts between common file formats. Provides casual users with a single interface for information, content generation, and file transformations.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- general public
- casual users

## Success criteria

- Users receive accurate answers to general questions within 5 seconds
- Image generation completes in under 30 seconds for 80% of requests
- File conversions succeed with 95% accuracy for supported formats

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with available features
- **/ask** (command, actor: user, command: /ask) — Pose a general knowledge question
  - inputs: question text
  - outputs: text answer
- **/image** (command, actor: user, command: /image) — Generate image from text prompt
  - inputs: image prompt
  - outputs: image file
- **/create_doc** (command, actor: user, command: /create_doc) — Start document creation flow
  - inputs: format selection, content text, attachments
  - outputs: document file
- **/convert** (command, actor: user, command: /convert) — Initiate file conversion
  - inputs: source file, target format
  - outputs: converted file

## Flows

### Q&A
_Trigger:_ /ask

1. Receive question
2. Generate answer
3. Send response with optional 'More details?' button

_Data touched:_ Request, Conversation

### Image Generation
_Trigger:_ /image

1. Receive prompt
2. Generate image
3. Send image with download button

_Data touched:_ Request, GeneratedAsset

### Document Creation
_Trigger:_ /create_doc

1. Choose format
2. Provide content
3. Generate document
4. Send file

_Data touched:_ Request, GeneratedAsset

### File Conversion
_Trigger:_ /convert

1. Upload file
2. Select target format
3. Convert file
4. Send converted file

_Data touched:_ Request, GeneratedAsset

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **User** _(retention: persistent)_ — Telegram account metadata
  - fields: telegram_id, language_preference
- **Conversation** _(retention: session)_ — Chat history tracking
  - fields: request_timestamp, last_active
- **Request** _(retention: persistent)_ — User request metadata
  - fields: type, format, timestamp
- **GeneratedAsset** _(retention: persistent)_ — Generated files and images
  - fields: file_type, storage_path, expiration

## Integrations

- **Telegram** (required) — Bot API messaging and file handling
- **Telegram Payments** (optional) — Subscription management
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure rate limits (free/paid tiers)
- Set file size limits
- Configure admin notification channel
- Enable/disable Telegram Payments integration

## Notifications

- Error alerts to owner's private channel
- Rate-limit warnings for abusive users
- Daily usage summary for owner

## Permissions & privacy

- Store user requests for 90 days for analytics
- Retain generated files for 7 days for redownload
- Scan files for malicious content types
- No HIPAA compliance by default

## Edge cases

- Files exceeding 25MB upload limit
- Unsupported conversion formats
- Telegram API rate limits during high load
- Malformed document templates

## Required tests

- Verify Q&A flow with 100+ sample questions
- Test image generation with 50+ prompts
- Validate document conversion matrix (PDF/DOCX/TXT/PNG/JPG)
- Simulate 1000 concurrent users for load testing

## Assumptions

- Primary language is English with optional multilingual support
- 25MB file size limit balances practicality and constraints
- 7-day asset retention meets user needs while controlling costs
- Telegram Payments integration is optional but recommended
