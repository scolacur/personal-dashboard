# D-004: Defer Chromaprint/AcoustID fingerprinting to TODO

**Decision:** MVP uses normalized-metadata fuzzy matching only. Fingerprinting goes to TODO.md.

**Reasoning:** Chromaprint solves a different problem than I have. My problem is "Spotify gave me metadata; do I have a file with matching metadata." Chromaprint solves "I have two audio files; are they the same recording?" The Spotify side doesn't give me audio — only metadata and (sometimes) a 30s preview URL. To use Chromaprint I'd need to download previews, fingerprint them, and do partial-fingerprint matching against full songs. That's a lot of complexity for a benefit that's mostly "catches cases where my own tags are wrong."

Better sequencing: see what the metadata matcher actually gets wrong over 2-3 weeks of real use. If the failure mode is tag inconsistency within my library, Chromaprint is the right fix. If it's Spotify's metadata not matching my filename conventions, Chromaprint won't help — better normalization rules will.

**Revisit if:** After ~3 weeks of observed failures, tag inconsistency in the local library is clearly the dominant cause of false negatives.
