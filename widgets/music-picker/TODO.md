# TODO — Music Picker Widget

## Multiple Spotify Playlists

- Allow configuring more than one Spotify playlist with a switcher (e.g., Morning, Evening, Deep Work)

## Bandcamp Collection Sync (Wishlist / Purchases)

- Bandcamp has no public API for collections — would require scraping the fan page
- Worth revisiting if the manual followed-artist list becomes too tedious to maintain

## Radio Station Categories / Groups

- Group starred stations (e.g., "Talk", "Electronic", "Jazz") for faster navigation

## NTS / Rinse.fm Native Embeds

- NTS has an official embeddable player (`https://www.nts.live/embeds/...`)
- Evaluate whether the native embed is preferable to stream URL playback for these specific stations
- Could be a per-station setting ("use embed" vs "use stream URL")

## Stream Health Check

- Periodically verify that stored stream URLs are still live
- Flag broken streams in the UI with a "stream may be offline" indicator

## "Mark as Listened / Noted" on Bandcamp Releases

- Checkbox or dismiss button per release so already-seen items collapse out of the list

## Audio Visualization

- Simple waveform or VU meter for the currently playing radio stream
