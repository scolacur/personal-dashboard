import type Database from 'better-sqlite3';
import { migrate } from '../../migrate';
import type { IdeaType } from '@dashboard/shared';

const SEED_IDEAS: { text: string; type: IdeaType }[] = [
  { type: 'Acute', text: 'Adding chorus/vibrato/rotary to a 303' },
  { type: 'Acute', text: 'sending CV from a 303 line to Erebus or another non-303 synth' },
  { type: 'Acute', text: 'dueling acid basslines panned L/R' },
  { type: 'Acute', text: 'A big long ambient wash' },
  { type: 'Acute', text: 'Tape echos everywhere' },
  { type: 'Acute', text: 'Have different notes in the melody produced with different instruments' },
  {
    type: 'Acute',
    text: 'Utilize the stereo field more, eg automated panning, panning the highs left and right while keeping the lows and mids center / widening something as a low pass filter sweeps',
  },
  { type: 'Acute', text: 'automating chorus mix up during a moment of tension' },
  { type: 'Acute', text: 'reverse something' },
  {
    type: 'Acute',
    text: 'play a melody (a new one or one thats already in the song) with a pitched vocal snippet',
  },
  { type: 'Acute', text: 'Add lofi fx to something or the whole mix' },
  { type: 'Acute', text: 'Automate repeat rate of tape echo for pitch shift spacey thing' },
  {
    type: 'Acute',
    text: 'If you have a really good sequence or melody, play it in one timbre / patch followed by a very different timbre',
  },
  {
    type: 'Acute',
    text: 'Make a fast, crazy 64 or 128 step sequence by recording myself playing 3-4 notes with the arpeggiator on and just moving some notes around gradually. probably 2-3 octave setting on the arp. And play it multiple times using different synth lead patches.',
  },
  { type: 'Acute', text: 'Beatmash it' },
  { type: 'Acute', text: 'Add some silence' },
  { type: 'Acute', text: 'Bitcrush it' },
  { type: 'Acute', text: 'Look at the Production Checklist in workflowy' },
  { type: 'Acute', text: 'Reverse Something' },
  { type: 'Acute', text: 'Put a mild LFO on the master tempo, maybe it will have a cool seasick feel' },
  { type: 'Acute', text: 'Have the melody move around in the left right space' },
  { type: 'Acute', text: 'Glitch out the melody for a part' },
  { type: 'Acute', text: 'Make a drone using a ton of reverb' },
  { type: 'Acute', text: 'Add transitions' },
  { type: 'Acute', text: 'Reverse Reverb' },
  { type: 'Acute', text: 'Pitch random vocal or melody notes up/down by an octave' },
  {
    type: 'Acute',
    text: 'Tobacco-fy voice using the serum setting from the Constellation Dirtbike project',
  },
  {
    type: 'Acute',
    text: "Try having the amplitude of an instrument mapped to control the dry/wet of all the effects its sent to, inverted. So the quieter you play the more the effects are applied and the louder you play the dryer the signal becomes. Would be great for delays, allowing for dynamic playing without getting too muddy when you play loud.",
  },
  {
    type: 'Acute',
    text: 'automate distortion so a note gets more distorted as it rings out (and maybe do the same with stereo spread)',
  },
  { type: 'Acute', text: 'Draw Inspiration from someone else' },
  { type: 'Acute', text: 'Think about where each instrument would be in a physical space' },
  { type: 'Acute', text: 'dorothy ashby harp sample' },
  {
    type: 'Acute',
    text: 'shift part of the melody up an octave as a variation / alternative / response to the normal melody',
  },
  { type: 'Acute', text: 'loon sample in a drum beat' },
  {
    type: 'Acute',
    text: "If it's a dancey beat, add a trip hop section. if its a trip hop beat, add a dancey section. no reason why you cant have the same chorus repeat 3 times at totally different vibes and tempos.",
  },
  { type: 'Inspiration', text: 'Patrick Holland' },
  { type: 'Inspiration', text: 'Lapalux' },
  { type: 'Inspiration', text: 'M83' },
  { type: 'Inspiration', text: 'Chrome Sparks' },
  { type: 'Inspiration', text: 'Greyhat' },
  { type: 'Inspiration', text: 'Kirvy' },
  { type: 'Inspiration', text: 'LUUUL' },
  { type: 'Inspiration', text: 'Catching Flies' },
  { type: 'Inspiration', text: 'Luke Abbot' },
  { type: 'Inspiration', text: 'Hemsworth' },
  { type: 'Inspiration', text: 'Ametsub' },
  { type: 'Inspiration', text: 'Affelaye' },
  { type: 'Inspiration', text: '.que' },
  { type: 'Inspiration', text: 'Mt. Kimbie' },
  { type: 'Inspiration', text: 'Tobacco' },
  { type: 'Inspiration', text: 'J Dilla' },
  { type: 'Inspiration', text: 'Skee Mask' },
  { type: 'Inspiration', text: 'Toro Y Moi' },
  { type: 'Inspiration', text: 'Left/Right' },
  { type: 'Inspiration', text: 'wrlds' },
  { type: 'Inspiration', text: 'Jock Jams' },
  { type: 'Inspiration', text: 'Go! Team' },
  { type: 'Inspiration', text: 'Bon Iver' },
  { type: 'Inspiration', text: 'Tom VR' },
  { type: 'Inspiration', text: 'Rival Consoles' },
  { type: 'Inspiration', text: 'Yppah' },
  { type: 'Inspiration', text: 'Synkro' },
  { type: 'Inspiration', text: 'Burial' },
  { type: 'Inspiration', text: 'Soccer Mommy' },
  { type: 'Inspiration', text: 'that. dog' },
  { type: 'Inspiration', text: 'Tourist' },
  { type: 'Inspiration', text: 'Dan Deacon' },
  { type: 'Inspiration', text: 'Touch Sensitive' },
  { type: 'Inspiration', text: 'French 79' },
  { type: 'Inspiration', text: 'Sohn' },
  { type: 'Inspiration', text: 'Sufjan Stevens' },
  { type: 'Inspiration', text: 'American Football' },
  { type: 'Inspiration', text: 'SOPHIE' },
  { type: 'Inspiration', text: 'Daft Punk' },
  { type: 'Inspiration', text: 'Sir Was' },
  { type: 'Inspiration', text: 'Tame Impala' },
  { type: 'Inspiration', text: 'Kucka' },
  { type: 'Inspiration', text: 'The Album Leaf' },
];

export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asg_ideas (
      id         INTEGER PRIMARY KEY,
      text       TEXT    NOT NULL,
      type       TEXT    NOT NULL,
      tags       TEXT    NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asg_ideas_type ON asg_ideas (type);
  `);

  migrate(db, 'asg_seed_initial_ideas', (d) => {
    const now = Date.now();
    const insert = d.prepare(
      'INSERT INTO asg_ideas (text, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const idea of SEED_IDEAS) {
      insert.run(idea.text, idea.type, '[]', now, now);
    }
  });
}
