const WebSocket = require('ws');

// Mock data to simulate what the extension would send
const mockPayload = {
  type: 'REACT_SNAPSHOT',
  tabId: 1234,
  siteVersion: 'test-v1',
  payload: {
    capturedAt: Date.now(),
    version: '18.0.0',
    buildType: 'production',
    componentTree: { n: 'App', t: 1, d: 0, c: [] }
  }
};

async function runTest() {
  console.log('--- Starting Test ---');
  const ws = new WebSocket('ws://localhost:7891');

  ws.on('open', () => {
    console.log('Connected to server, sending mock REACT_SNAPSHOT...');
    ws.send(JSON.stringify(mockPayload));
  });

  ws.on('message', (data) => {
    console.log('Received:', data.toString());
  });

  // Give it a moment to receive and process
  setTimeout(() => {
    console.log('Test finished.');
    process.exit(0);
  }, 2000);
}

runTest();
