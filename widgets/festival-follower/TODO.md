# TODO — Music Festival Follower Widget

## Structured Lineup Extraction

- When a lineup announcement is detected (via RSS or page change), attempt to extract artist names
- Could use a simple heuristic (look for large bold text blocks, lists of names) or an LLM to parse the page
- Surface artists as individual items linked to Concert Discovery (cross-reference with followed artists)

## Ticket Sale Alerts

- Detect specific patterns on festival pages that indicate ticket links going live
- Could monitor a known "tickets" URL for changes from 404/sold-out → available

## Social Media Monitoring

- Scrape or monitor the festival's Twitter/Instagram for announcements
- High complexity, API-restricted — long-term only

## "What Changed" Diff for Page Changes

- Instead of just "something changed," show a text diff of the page content between checks
- Needs thoughtful filtering (remove nav/footer noise, focus on content area)

## Email Newsletter Integration

- Some festivals only announce via newsletter
- Inbound email parsing (e.g., forward festival emails to a local address, parse them into the feed)

## Auto-Archive Past Festivals

- When `end_date` has passed, automatically move to an archive section
- Archive view: see updates from past festivals by year

## Cross-reference with Concert Discovery

- If an artist in a lineup announcement matches a followed artist in Concert Discovery, highlight it
- "Objekt is playing Dekmantel 2026" — surfaced as a high-priority update
