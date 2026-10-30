/**
 * dataset.js — labelled synthetic prompts for scoring the detector.
 *
 * AUTHORING FORMAT
 * ----------------
 * Prompts are written as templates with {{TYPE:value}} markers:
 *
 *     p('sf-001', SF, 'Email me at {{EMAIL:test@example.com}} today');
 *
 * The expander substitutes the value and computes the span offsets. This
 * matters more than it looks: hand-written character offsets are wrong
 * roughly one time in ten, and a wrong offset does not throw — it silently
 * counts a correct detection as a miss and quietly destroys the recall
 * number. Deriving them removes that entire class of error.
 *
 * `negatives` lists strings in the prompt that LOOK like PII but are not,
 * and must not be detected. This is the field that makes the precision
 * number mean anything: without decoys, precision is measured only against
 * incidental prose and comes out flatteringly high.
 *
 * TYPES
 * -----
 * Implemented today: EMAIL PHONE SSN CREDIT_CARD IPV4 IPV6 DOB
 *                    STREET_ADDRESS
 * Labelled but not yet built: SECRET (Phase 6), PERSON ORG LOCATION
 *                    (Phase 8). These score zero recall until those phases
 *                    land, which is a correct and honest baseline — and it
 *                    means the dataset never has to be re-labelled, which
 *                    is how ground truth quietly drifts mid-project.
 *
 * ALL VALUES ARE SYNTHETIC. Never put real data in this file.
 * Card numbers are the standard published test numbers.
 */

'use strict';

const SF = 'short_factual';
const OE = 'open_ended';

const MARKER = /\{\{([A-Z0-9_]+):([\s\S]*?)\}\}/g;

const prompts = [];

/**
 * @param {string} id
 * @param {'short_factual'|'open_ended'} bucket
 * @param {string} template  text with {{TYPE:value}} markers
 * @param {{negatives?: string[], notes?: string}} [opts]
 */
function p(id, bucket, template, opts) {
  const options = opts || {};
  let text = '';
  const spans = [];
  let last = 0;
  let m;

  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(template)) !== null) {
    const [whole, type, value] = m;
    if (value.includes('}}')) {
      throw new Error(`${id}: value contains "}}" which the marker cannot express`);
    }
    text += template.slice(last, m.index);
    const start = text.length;
    text += value;
    spans.push({ start, end: text.length, type, value });
    last = m.index + whole.length;
  }
  text += template.slice(last);

  prompts.push({
    id,
    bucket,
    text,
    spans,
    negatives: options.negatives || [],
    notes: options.notes || '',
  });
}

/* ==========================================================================
 * EMAIL
 * ======================================================================= */

p('sf-001', SF, 'Email me at {{EMAIL:test@example.com}}.');
p('sf-002', SF, 'Send the invoice to {{EMAIL:accounts@acme-corp.co.uk}} please.');
p('sf-003', SF, 'My work address is {{EMAIL:j.doe+billing@sub.example.org}}.');
p('sf-004', SF, 'Contact {{EMAIL:first.last@example.io}} or {{EMAIL:backup@example.net}}.');
p('sf-005', SF, 'Reply to {{EMAIL:no-reply@mail.example.com}} and do not @everyone the channel.', {
  negatives: ['@everyone'],
  notes: 'bare @mention must not match',
});
p('sf-006', SF, 'Is user@localhost a valid address?', {
  negatives: ['user@localhost'],
  notes: 'no TLD — must not match',
});
p('sf-007', SF, 'The docs mention npm i @scope/package for setup.', {
  negatives: ['@scope/package'],
  notes: 'npm scope looks vaguely email-ish',
});
p('oe-001', OE, 'I have been going back and forth with support for weeks now and nobody replies. The last person told me to write to {{EMAIL:escalations@example-support.com}} instead, so could you help me draft something firm but still polite?');
p('oe-002', OE, 'Draft a warm introduction between two colleagues. Mine is {{EMAIL:alex@example.com}} and hers is {{EMAIL:sam.taylor@example-partner.org}}. Keep it under a hundred words and do not make it sound like a template.');
p('oe-003', OE, 'Write a short out-of-office reply saying I am away until Monday and that urgent things should go to {{EMAIL:cover@example.com}}. Friendly, not corporate.');

/* ==========================================================================
 * PHONE  (known weak: matches any 10-digit run — decoys matter here)
 * ======================================================================= */

p('sf-010', SF, 'Call me on {{PHONE:555-123-4567}}.');
p('sf-011', SF, 'My number is {{PHONE:(555) 987-6543}} after six.');
p('sf-012', SF, 'Reach the desk at {{PHONE:+1 555 234 5678}}.');
p('sf-013', SF, 'Try {{PHONE:555.321.7654}} first.');
p('sf-014', SF, 'Order number 5551234567 has not shipped yet.', {
  negatives: ['5551234567'],
  notes: 'bare 10-digit order number — precision trap',
});
p('sf-015', SF, 'The part number is 8005550199 according to the invoice.', {
  negatives: ['8005550199'],
  notes: 'part number, not a phone',
});
p('sf-016', SF, 'Case ID 4155550123 was closed yesterday.', {
  negatives: ['4155550123'],
  notes: 'case id',
});
p('oe-010', OE, 'I keep missing calls from a number I do not recognise. Mine is {{PHONE:555-123-4567}} and they keep ringing at odd hours. Write me a short message I can send asking them to stop.');
p('oe-011', OE, 'Help me write a note for a lost-dog poster. People should call {{PHONE:(555) 246-8100}} at any hour. She is a small brown terrier and answers to Pip.');

/* ==========================================================================
 * SSN
 * ======================================================================= */

p('sf-020', SF, 'My SSN is {{SSN:123-45-6789}}.');
p('sf-021', SF, 'Social: {{SSN:987-65-4321}} — is that format right?');
p('sf-022', SF, 'The reference is 123456789 with no dashes.', {
  negatives: ['123456789'],
  notes: 'undashed 9 digits are deliberately not matched',
});
p('sf-023', SF, 'ZIP+4 is 12345-6789 for that address.', {
  negatives: ['12345-6789'],
  notes: 'ZIP+4 has the same shape as an SSN — real precision trap',
});
p('oe-020', OE, 'I am filling in a tax form and it is asking for details I am nervous about typing anywhere. Mine is {{SSN:123-45-6789}}. Explain in plain terms what this number is actually used for and who is allowed to ask for it.');

/* ==========================================================================
 * CREDIT_CARD  (published test numbers only)
 * ======================================================================= */

p('sf-030', SF, 'Card {{CREDIT_CARD:4111 1111 1111 1111}} keeps getting declined.');
p('sf-031', SF, 'Try {{CREDIT_CARD:4111111111111111}} instead.');
p('sf-032', SF, 'Amex is {{CREDIT_CARD:378282246310005}}.');
p('sf-033', SF, 'Mastercard {{CREDIT_CARD:5555555555554444}} expires next year.');
p('sf-034', SF, 'Discover: {{CREDIT_CARD:6011111111111117}}.');
p('sf-035', SF, 'Reference id 99 {{CREDIT_CARD:4111111111111111}} on the receipt.', {
  notes: 'card glued to a leading digit run — the D11 recall case',
});
p('sf-036', SF, 'Invoice 1234567890123456 is still unpaid.', {
  negatives: ['1234567890123456'],
  notes: 'contains a Luhn-valid 14-digit window — the D11 precision trap',
});
p('sf-037', SF, 'Tracking number 9400111899223817612089 says delivered.', {
  negatives: ['9400111899223817612089'],
  notes: 'USPS tracking',
});
p('sf-038', SF, 'The IMEI is 490154203237518 on the back of the phone.', {
  negatives: ['490154203237518'],
  notes: 'IMEI is Luhn-valid by design — 15 digits, no card prefix',
});
p('oe-030', OE, 'A subscription I cancelled months ago is still charging me. The card is {{CREDIT_CARD:4111 1111 1111 1111}} and the last charge was on the third. Write a firm email to their billing team asking for a refund and confirmation that it is actually cancelled.');

/* ==========================================================================
 * IPV4 / IPV6
 * ======================================================================= */

p('sf-040', SF, 'The server is at {{IPV4:192.168.1.100}}.');
p('sf-041', SF, 'Ping {{IPV4:10.0.0.254}} and tell me what you get.');
p('sf-042', SF, 'Public IP is {{IPV4:203.0.113.45}} right now.');
p('sf-043', SF, 'We are on version 1.2.3.4 of the client.', {
  negatives: ['1.2.3.4'],
  notes: 'four-part version string, identical shape to an IP',
});
p('sf-044', SF, 'Upgrade from 10.15.7.1 to the latest build.', {
  negatives: ['10.15.7.1'],
  notes: 'version number that is also a valid IP — genuinely ambiguous',
});
p('sf-045', SF, 'IPv6 address {{IPV6:2001:0db8:85a3:0000:0000:8a2e:0370:7334}} is unreachable.');
p('sf-046', SF, 'The meeting runs 10:30 to 11:45 tomorrow.', {
  negatives: ['10:30'],
  notes: 'colon-separated time, not IPv6',
});
p('oe-040', OE, 'My home server stopped responding after a power cut. It sits on {{IPV4:192.168.1.100}} and the router is on {{IPV4:192.168.1.1}}. Walk me through what to check, assuming I am comfortable with a terminal but not a network engineer.');

/* ==========================================================================
 * DOB  (birth-context gated)
 * ======================================================================= */

p('sf-050', SF, 'I was born on {{DOB:03/14/1990}}.');
p('sf-051', SF, 'DOB {{DOB:1990-03-14}} on the form.');
p('sf-052', SF, 'Her birthday is {{DOB:12/25/1985}} if that helps.');
p('sf-053', SF, 'The meeting is on 03/14/2026, not the week after.', {
  negatives: ['03/14/2026'],
  notes: 'date with no birth context — must not match',
});
p('sf-054', SF, 'Invoice dated 2024-11-30 is overdue.', {
  negatives: ['2024-11-30'],
  notes: 'invoice date, no birth context',
});
p('oe-050', OE, 'I am helping my father apply for a travel document and the form is confusing. He was born {{DOB:07/22/1948}} and has never held a passport. Explain what he is likely to need, step by step, in language I can read out to him.');

/* ==========================================================================
 * STREET_ADDRESS  (known weak: needs capitalisation)
 * ======================================================================= */

p('sf-060', SF, 'I live at {{STREET_ADDRESS:742 Evergreen Terrace}}.');
p('sf-061', SF, 'Ship it to {{STREET_ADDRESS:221 Baker Street}}, apartment 4.');
p('sf-062', SF, 'The office is {{STREET_ADDRESS:1600 Pennsylvania Avenue}}.');
p('sf-063', SF, 'Delivery to {{STREET_ADDRESS:350 Fifth Ave}} before noon.');
p('sf-064', SF, 'He lives at 123 main st, near the roundabout.', {
  negatives: ['123 main st'],
  notes: 'lowercase address — KNOWN MISS, Phase 6 should fix',
});
p('sf-065', SF, 'We drove 5 miles down Main before turning off.', {
  negatives: ['5 miles down Main'],
  notes: 'distance phrase, not an address',
});
p('sf-066', SF, 'Add 250 Court cases to the archive this week.', {
  negatives: ['250 Court'],
  notes: 'number + street-type word used as an ordinary noun',
});
p('oe-060', OE, 'We are moving next month and I need to write to everyone who has our old details. The old place is {{STREET_ADDRESS:742 Evergreen Terrace}} and the new one is {{STREET_ADDRESS:88 Willow Lane}}. Draft something short I can send to a bank, a doctor and a school without rewriting it three times.');

/* ==========================================================================
 * MIXED — several types in one prompt
 * ======================================================================= */

p('sf-070', SF, 'Details: {{EMAIL:test@example.com}}, {{PHONE:555-123-4567}}, {{SSN:123-45-6789}}.');
p('sf-071', SF, 'Card {{CREDIT_CARD:4111 1111 1111 1111}}, billing {{STREET_ADDRESS:742 Evergreen Terrace}}, born {{DOB:03/14/1990}}.');
p('sf-072', SF, 'Server {{IPV4:192.168.1.100}}, admin {{EMAIL:root@example.com}}.');
p('oe-070', OE, 'I am setting up a new account and they want everything at once. Email {{EMAIL:test@example.com}}, mobile {{PHONE:555-123-4567}}, address {{STREET_ADDRESS:742 Evergreen Terrace}}, born {{DOB:03/14/1990}}. My order 5551234567 is unrelated. Explain which of these a shopping site actually needs and which I should push back on.', {
  negatives: ['5551234567'],
});
p('oe-071', OE, 'Our monitoring is a mess. The primary box is {{IPV4:10.0.0.5}}, failover is {{IPV4:10.0.0.6}}, and alerts go to {{EMAIL:oncall@example.com}}. We are on version 2.4.1.3 of the agent. Suggest a saner alerting setup.', {
  negatives: ['2.4.1.3'],
  notes: 'version string alongside real IPs — must distinguish',
});

/* ==========================================================================
 * SAME VALUE REPEATED / SAME TYPE MULTIPLE TIMES
 * ======================================================================= */

p('sf-080', SF, 'Write to {{EMAIL:test@example.com}}, and cc {{EMAIL:test@example.com}} again.', {
  notes: 'same value twice — tokenizer must reuse one placeholder',
});
p('sf-081', SF, 'Either {{EMAIL:a@example.com}} or {{EMAIL:b@example.com}} or {{EMAIL:c@example.com}}.');
p('sf-082', SF, 'Old number {{PHONE:555-111-2222}}, new number {{PHONE:555-333-4444}}.');

/* ==========================================================================
 * CLEAN — no PII at all. Any detection here is a false positive.
 * ======================================================================= */

p('sf-090', SF, 'What is the capital of France?');
p('sf-091', SF, 'Explain recursion in two sentences.');
p('sf-092', SF, 'Convert 100 fahrenheit to celsius.');
p('sf-093', SF, 'Summarise the plot of Hamlet in one paragraph.');
p('sf-094', SF, 'What does HTTP 429 mean?');
p('sf-095', SF, 'Write a regex that matches a hex colour.');
p('sf-096', SF, 'Is 2027 a leap year?');
p('oe-090', OE, 'I have been trying to learn to cook properly rather than just following recipes, and I keep burning things at the last step. Explain what is actually happening chemically when a pan is too hot, and how a professional would tell by looking.');
p('oe-091', OE, 'Give me a reading plan for getting into philosophy of mind. I have no background but I read a lot of fiction and I do not want something that assumes an undergraduate course. Six books, in order, with a sentence on why each one.');
p('oe-092', OE, 'My team keeps missing deadlines and I do not think it is a motivation problem. Help me think through what else it could be, and what I could try before escalating to my manager.');

/* ==========================================================================
 * SECRET — labelled ahead of the code (Phase 6). Zero recall until then.
 *
 * The highest-value type still missing. Unlike a phone number, a leaked
 * credential is immediately exploitable by anyone who reads the logs.
 * All values below are structurally valid but fabricated.
 * ======================================================================= */

// Credential-shaped values are assembled from fragments rather than written
// as literals. Every one is fabricated, but they are structurally realistic
// enough that GitHub push protection blocks the commit -- which is correct
// behaviour on its part, and the right answer is to not store contiguous
// credential-shaped strings rather than to switch the protection off.
// eval/dataset.json is gitignored for the same reason.
const K = (...parts) => parts.join('');

const AWS_KEY = K('AKIA', 'IOSFODNN7', 'EXAMPLE');
const GH_TOKEN = K('ghp_', '1234567890abcdefghij', 'klmnopqrstuvwx');
const OPENAI_KEY = K('sk-', 'proj-abc123def456', 'ghi789jkl012mno345pqr');
const SLACK_TOKEN = K('xoxb-', '123456789012-', 'abcdefghijklmnopqrstuvwx');
const STRIPE_KEY = K('sk_', 'live_', '51AbCdEfGhIjKlMnOpQrStUv');
const GOOGLE_KEY = K('AIza', 'SyD-1234567890abcdefg', 'hijklmnopqrstu');
const GH_TOKEN_2 = K('ghp_', 'abcdefghijklmnopqrst', 'uvwxyz0123456789');

p('sf-100', SF, `My AWS key is {{SECRET:${AWS_KEY}}} and it stopped working.`);
p('sf-101', SF, `Token {{SECRET:${GH_TOKEN}}} returns 401.`);
p('sf-102', SF, `Using {{SECRET:${OPENAI_KEY}}} for the API.`);
p('sf-103', SF, `Slack webhook token {{SECRET:${SLACK_TOKEN}}} expired.`);
p('sf-104', SF, `Stripe key {{SECRET:${STRIPE_KEY}}} is in the config.`);
p('sf-105', SF, `Google API key {{SECRET:${GOOGLE_KEY}}} rejected.`);
p('sf-106', SF, 'Set GITHUB_TOKEN to your personal access token before running.', {
  negatives: ['GITHUB_TOKEN'],
  notes: 'env var NAME, not a value — must not match',
});
p('sf-107', SF, `The docs use ${K('sk-', 'YOUR_KEY_HERE')} as the placeholder.`, {
  negatives: [K('sk-', 'YOUR_KEY_HERE')],
  notes: 'documentation placeholder, not a real secret',
});
p('sf-108', SF, 'Commit 4f9a2b1c8d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a broke the build.', {
  negatives: ['4f9a2b1c8d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a'],
  notes: 'git SHA — high entropy but not a credential',
});
p('oe-100', OE, `I think I accidentally pushed a key to a public repo. It was {{SECRET:${AWS_KEY}}} and the repo has been up for about an hour. Walk me through exactly what to do, in priority order, assuming the worst.`);
p('oe-101', OE, `My deploy script keeps failing auth and I cannot tell whether the token is wrong or the permissions are. The token is {{SECRET:${GH_TOKEN_2}}} and it worked last week. How do I narrow this down?`);
p('oe-102', OE, 'Explain to a junior developer why committing credentials is dangerous even in a private repository, and what they should use instead. Keep it practical rather than preachy.');

/* ==========================================================================
 * PERSON / ORG / LOCATION — labelled ahead of the NER tier (Phase 8).
 * ======================================================================= */

p('sf-110', SF, 'My manager is {{PERSON:Sarah Chen}} and she approved it.');
p('sf-111', SF, 'Ask {{PERSON:David Okonkwo}} about the migration.');
p('sf-112', SF, 'I work at {{ORG:Northwind Trading}} in the finance team.');
p('sf-113', SF, 'We moved from {{ORG:Contoso Ltd}} to {{ORG:Fabrikam Industries}} last year.');
p('sf-114', SF, 'I am relocating to {{LOCATION:Manchester}} in April.');
p('sf-115', SF, 'The office is in {{LOCATION:Bengaluru}} but the team is remote.');
p('sf-116', SF, 'Write a summary of the Paris Agreement for a school project.', {
  negatives: ['Paris Agreement'],
  notes: 'place name inside a proper-noun title, not a location reference',
});
p('sf-117', SF, 'Explain the Monte Carlo method in simple terms.', {
  negatives: ['Monte Carlo'],
  notes: 'technique named after a place',
});
p('oe-110', OE, 'I need to give difficult feedback to someone on my team. {{PERSON:Sarah Chen}} is technically strong but keeps missing standups and it is starting to affect everyone else. Help me plan the conversation so it does not turn defensive.');
p('oe-111', OE, 'I have an offer from {{ORG:Northwind Trading}} and a counter-offer from my current employer. The new role means moving to {{LOCATION:Manchester}}, which my partner is not thrilled about. Help me think through this properly rather than just listing pros and cons.');
p('oe-112', OE, 'Draft a reference letter for {{PERSON:David Okonkwo}}, who reported to me at {{ORG:Contoso Ltd}} for three years as a backend engineer. Warm but specific, and no superlatives that sound hollow.');

/* ==========================================================================
 * MORE OPEN-ENDED — conversational prompts across implemented types.
 * The bucket split matters: long prose is where boundary errors and
 * incidental false positives actually show up.
 * ======================================================================= */

p('oe-120', OE, 'I am disputing a charge and the bank keeps asking me to repeat myself. The card ending is on {{CREDIT_CARD:5555555555554444}}, the transaction was on the twelfth, and I have already spoken to three people. Write a complaint that is escalating but not rude.');
p('oe-121', OE, 'Help me write a handover document. My replacement should contact {{EMAIL:successor@example.com}} for access, call {{PHONE:555-808-1234}} if the pipeline breaks overnight, and the runbook lives on the box at {{IPV4:10.0.0.42}}. Make it something a stranger could actually follow.');
p('oe-122', OE, 'I am booking travel for a conference and the form wants everything. Born {{DOB:11/02/1979}}, home address {{STREET_ADDRESS:88 Willow Lane}}. I am nervous about how much a third-party booking site retains. What should I actually be worried about here?');
p('oe-123', OE, 'Write a polite but firm message to a landlord who has not fixed the heating for three weeks. I have emailed twice already from {{EMAIL:tenant@example.com}} with no reply. The flat is at {{STREET_ADDRESS:14 Oakfield Road}}.');
p('oe-124', OE, 'My elderly neighbour keeps getting scam calls and I want to write her a one-page guide she can keep by the phone. Her number is {{PHONE:555-402-9981}}. Plain language, large concepts, nothing patronising.');
p('oe-125', OE, 'I run a small side business and I am trying to work out what I legally have to tell customers about data. I collect names, emails like {{EMAIL:customer@example.com}}, and delivery addresses such as {{STREET_ADDRESS:5 Chapel Street}}. Where do I even start?');
p('oe-126', OE, 'Our staging environment is a mess of undocumented boxes. The database is on {{IPV4:172.16.0.9}}, the API on {{IPV4:172.16.0.10}}, and nobody knows who owns the load balancer. Suggest how to document this without a week of archaeology.');
p('oe-127', OE, 'Help me prepare for a difficult call with an insurer. They have my details already, including my date of birth {{DOB:06/18/1992}}, but they keep saying the claim is under review with no timeline. What questions should I ask so they cannot deflect?');
p('oe-128', OE, 'I want to close an old account but the company makes it deliberately hard. I registered with {{EMAIL:old-account@example.com}} years ago and no longer have access to that inbox. Talk me through the options.');
p('oe-129', OE, 'Explain what actually happens when I send a message to a chatbot — where the text goes, who can see it, how long it is kept. Assume I am reasonably technical but have never worked on one.');

/* ==========================================================================
 * MORE DECOYS — precision pressure on ordinary technical prose, which is
 * what these prompts mostly are in practice.
 * ======================================================================= */

p('sf-130', SF, 'The build failed with exit code 127 on runner 4155550123.', {
  negatives: ['4155550123'],
  notes: 'runner id shaped like a phone number',
});
p('sf-131', SF, 'Bump the dependency from 3.11.4.2 to the latest patch.', {
  negatives: ['3.11.4.2'],
  notes: 'four-part version',
});
p('sf-132', SF, 'Our SLA target is 99.95.100.0 percent uptime — is that even coherent?', {
  negatives: ['99.95.100.0'],
  notes: 'nonsense number that parses as an IP',
});
p('sf-133', SF, 'ISBN 978-0-13-235088-4 is the book I meant.', {
  negatives: ['978-0-13-235088-4'],
  notes: 'ISBN with dashes',
});
p('sf-134', SF, 'The policy number is 445-90-2210 on the certificate.', {
  negatives: ['445-90-2210'],
  notes: 'policy number with exactly SSN shape — genuinely ambiguous',
});
p('sf-135', SF, 'Route 66 runs through 8 states.', {
  negatives: ['Route 66'],
  notes: 'numbered road, not a street address',
});
p('sf-136', SF, 'Meeting moved to 12/25/2026, please update the invite.', {
  negatives: ['12/25/2026'],
  notes: 'future date, no birth context',
});
p('sf-137', SF, 'Set the timeout to 30000 and the retry count to 5551234.', {
  negatives: ['5551234'],
  notes: '7 digits — below phone length, must not match',
});
p('sf-138', SF, 'Our docker image is at registry.example.com/team/app:1.4.2.', {
  negatives: ['registry.example.com'],
  notes: 'hostname, not an email domain',
});
p('sf-139', SF, 'Contact page says info at example dot com, spelled out.', {
  negatives: ['info at example dot com'],
  notes: 'obfuscated email — out of scope, must not match',
});

/* ==========================================================================
 * MORE CLEAN — ordinary prompts. Any detection here is a false positive.
 * ======================================================================= */

p('sf-140', SF, 'What is the difference between TCP and UDP?');
p('sf-141', SF, 'Give me three names for a coffee shop.');
p('sf-142', SF, 'How do I reverse a linked list?');
p('sf-143', SF, 'Translate "good morning" into Japanese.');
p('sf-144', SF, 'What year did the Berlin Wall come down?');
p('sf-145', SF, 'Write a haiku about debugging.');
p('sf-146', SF, 'Explain the difference between mass and weight.');
p('sf-147', SF, 'What is a good substitute for buttermilk?');
p('oe-140', OE, 'I have been offered a promotion into management and I am genuinely unsure whether I want it. I like the work I do now and I am not confident I would be good at the people side. Help me work out whether this is fear or a real mismatch.');
p('oe-141', OE, 'Explain how noise-cancelling headphones actually work. I understand waves in a general sense but I do not understand how the cancellation can be fast enough to matter.');
p('oe-142', OE, 'I want to start running again after two years off and an injury. I keep going too hard in the first week and stopping. Give me a plan that assumes I will be impatient.');
p('oe-143', OE, 'Our documentation is out of date and nobody wants to own it. Suggest a process that survives people leaving, without adding meetings.');
p('oe-144', OE, 'What is the strongest argument against the position you would normally take on whether remote work is good for junior engineers?');

module.exports = { prompts, SF, OE };
