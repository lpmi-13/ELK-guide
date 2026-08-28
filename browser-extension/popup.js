const form = document.querySelector('#pair-form');
const status = document.querySelector('#status');
const fields = ['server', 'session', 'code'];

chrome.storage.local.get(fields).then(saved => {
  for (const name of fields) {
    if (saved[name]) document.querySelector(`#${name}`).value = saved[name];
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = 'Pairing…';
  const config = Object.fromEntries(fields.map(name => [name, document.querySelector(`#${name}`).value.trim()]));
  await chrome.storage.local.set(config);
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.url?.match(/^http:\/\/(localhost|127\.0\.0\.1):5601\//)) {
    status.textContent = 'Open the local Kibana tab before pairing.';
    return;
  }
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, {type: 'incident-coach-pair', config});
    status.textContent = reply?.ok ? 'Paired. The coach is visible in Kibana.' : (reply?.error || 'Pairing failed.');
  } catch (error) {
    status.textContent = `Pairing failed: ${error.message}`;
  }
});
