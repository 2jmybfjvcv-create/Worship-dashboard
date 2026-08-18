// This runs on the server (never in the browser), so your Planning Center
// credentials stay hidden from anyone who views the dashboard's source code.

const SERVICE_TYPE_ID = '173831'; // Sunday Service

// Each entry pulls one Planning Center "team" and labels it for the dashboard.
// To add or change which PCO teams show up, edit this list.
const TEAMS = [
  { id: '4835826', label: 'Worship Team' },
  { id: '1011821', label: 'Service Leadership' }, // Speaker, Announcements, Corporate Prayer
];

module.exports = async function handler(req, res) {
  const APP_ID = process.env.PCO_APP_ID;
  const SECRET = process.env.PCO_SECRET;

  if (!APP_ID || !SECRET) {
    return res.status(500).json({
      error: 'Missing PCO_APP_ID or PCO_SECRET environment variables.',
    });
  }

  const authHeader = 'Basic ' + Buffer.from(`${APP_ID}:${SECRET}`).toString('base64');

  try {
    // 1. Find the next upcoming Sunday's plan
    const planRes = await fetch(
      `https://api.planningcenteronline.com/services/v2/service_types/${SERVICE_TYPE_ID}/plans?filter=future&per_page=1&order=sort_date`,
      { headers: { Authorization: authHeader } }
    );

    if (!planRes.ok) {
      throw new Error(`Planning Center plan lookup failed (${planRes.status})`);
    }

    const planData = await planRes.json();

    if (!planData.data || planData.data.length === 0) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ date: null, teams: {}, order: [] });
    }

    const plan = planData.data[0];
    const planId = plan.id;
    const planDate = plan.attributes.dates;

    // 2. Get each team's members scheduled on that plan.
    // While we're at it, build lookup maps so we can resolve "who's leading
    // this song/item" later -- Planning Center assigns a leader either to a
    // specific person, or to a position (e.g. "Speaker"), so we need both.
    const teams = {};
    const nameByPersonId = {};
    const nameByPositionName = {};

    for (const team of TEAMS) {
      const teamRes = await fetch(
        `https://api.planningcenteronline.com/services/v2/service_types/${SERVICE_TYPE_ID}/plans/${planId}/team_members?per_page=100&where[team_id]=${team.id}`,
        { headers: { Authorization: authHeader } }
      );

      if (!teamRes.ok) {
        throw new Error(`Planning Center team lookup failed for ${team.label} (${teamRes.status})`);
      }

      const teamData = await teamRes.json();
      const activeMembers = (teamData.data || []).filter((p) => p.attributes.status !== 'D');

      for (const p of activeMembers) {
        const personId = p.relationships && p.relationships.person && p.relationships.person.data
          ? p.relationships.person.data.id
          : null;
        const role = (p.attributes.team_position_name || '').trim().toLowerCase();
        if (personId) nameByPersonId[personId] = p.attributes.name;
        if (role) nameByPositionName[role] = p.attributes.name;
      }

      teams[team.label] = activeMembers.map((person) => ({
        name: person.attributes.name,
        role: person.attributes.team_position_name,
        photo: person.attributes.photo_thumbnail,
        confirmed: person.attributes.status === 'C',
      }));
    }

    // 3. Get the order of service (section headers + songs, in order).
    // This walks whatever is actually in the plan that week -- if a header
    // or song is added, removed, or reordered in Planning Center, it shows
    // up here automatically on the next refresh. No code changes needed.
    //
    // Most "item" entries (sermon notes, giving prompts, etc.) are internal
    // planning detail and get skipped -- except under the headers listed
    // below, where the full breakdown is genuinely useful on the TV.
    const EXPAND_ITEMS_UNDER = ['giving & announcements', 'message | speaker'];

    const itemsRes = await fetch(
      `https://api.planningcenteronline.com/services/v2/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items?per_page=100&include=item_assignments`,
      { headers: { Authorization: authHeader } }
    );

    if (!itemsRes.ok) {
      throw new Error(`Planning Center items lookup failed (${itemsRes.status})`);
    }

    const itemsData = await itemsRes.json();
    const sortedItems = (itemsData.data || []).sort(
      (a, b) => a.attributes.sequence - b.attributes.sequence
    );

    // Group the included item_assignments by which item they belong to.
    const assignmentsByItemId = {};
    for (const inc of itemsData.included || []) {
      if (inc.type !== 'ItemAssignment') continue;
      const itemId = inc.relationships && inc.relationships.item && inc.relationships.item.data
        ? inc.relationships.item.data.id
        : null;
      const assignable = inc.relationships && inc.relationships.assignable ? inc.relationships.assignable.data : null;
      if (!itemId || !assignable) continue;
      if (!assignmentsByItemId[itemId]) assignmentsByItemId[itemId] = [];
      assignmentsByItemId[itemId].push(assignable); // { type: 'Person' | 'TeamPosition', id }
    }

    // "TeamPosition" assignments name a role (e.g. "Speaker"), not a person --
    // resolve those to a position name once each and cache it, then match
    // that name against the people we already fetched above.
    const positionNameCache = {};
    async function resolveTeamPositionName(positionId) {
      if (positionId in positionNameCache) return positionNameCache[positionId];
      try {
        const posRes = await fetch(
          `https://api.planningcenteronline.com/services/v2/team_positions/${positionId}`,
          { headers: { Authorization: authHeader } }
        );
        const name = posRes.ok ? (await posRes.json()).data.attributes.name : null;
        positionNameCache[positionId] = name;
        return name;
      } catch (e) {
        positionNameCache[positionId] = null;
        return null;
      }
    }

    async function resolveLeaderName(itemId) {
      const assignable = (assignmentsByItemId[itemId] || [])[0];
      if (!assignable) return null;

      if (assignable.type === 'Person') {
        return nameByPersonId[assignable.id] || null;
      }
      if (assignable.type === 'TeamPosition') {
        const positionName = await resolveTeamPositionName(assignable.id);
        return positionName ? (nameByPositionName[positionName.trim().toLowerCase()] || null) : null;
      }
      return null;
    }

    const order = [];
    for (const item of sortedItems) {
      const attrs = item.attributes;

      if (attrs.item_type === 'header') {
        order.push({ title: attrs.title, songs: [] });
      } else if (attrs.item_type === 'song') {
        const leader = await resolveLeaderName(item.id);
        const song = { title: attrs.title, key: attrs.key_name || null, leader };
        if (order.length > 0) {
          order[order.length - 1].songs.push(song);
        } else {
          order.push({ title: 'Songs', songs: [song] });
        }
      } else if (attrs.item_type === 'item') {
        const currentHeader = order.length > 0 ? order[order.length - 1] : null;
        const shouldExpand =
          currentHeader && EXPAND_ITEMS_UNDER.includes((currentHeader.title || '').trim().toLowerCase());
        if (shouldExpand) {
          const leader = await resolveLeaderName(item.id);
          currentHeader.songs.push({ title: attrs.title, key: null, leader });
        }
        // otherwise skipped -- internal planning detail, not useful on the TV
      }
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ date: planDate, teams, order });
  } catch (err) {
    return res.status(500).json({ error: 'Could not reach Planning Center.' });
  }
};
