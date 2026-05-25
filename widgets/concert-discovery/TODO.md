# TODO — Concert Discovery Widget

## RA Account Auth — Auto-sync Follows

- Authenticate with the user's RA account to fetch the existing following list automatically
- Eliminates the need to manually maintain artist slugs
- RA auth is cookie-based (no OAuth); approach would be a one-time login flow that captures a session cookie and stores it encrypted

## Custom Artist List (non-RA artists)

- Add artists by name without an RA slug
- Look them up on alternative sources (Songkick, Bandcamp, their own tour pages)

## Songkick Integration

- Songkick has a proper public REST API with an API key
- Stronger for mainstream / non-electronic artists
- Could run in parallel with RA: deduplicate events by artist + venue + date

## Social / Tour Page Scraping

- For artists with no Songkick/RA presence, monitor their own tour page or Instagram for event announcements
- High complexity, fragile — long-term only

## "Interested" / "Going" Tracking

- Mark events with interest level (interested, going, passed)
- Filter feed by status
- Past events automatically archived

## Calendar Export

- Export upcoming shows as an `.ics` file or push to Google Calendar
- Makes it easy to check against personal calendar before buying tickets

## RA API Breakage Mitigation

- If RA changes their API, fallback to scraping RA artist pages directly (less reliable but same data)
- Monitor for 4xx/5xx responses on the GraphQL endpoint and surface a warning in the widget
