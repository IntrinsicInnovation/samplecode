// public/app.js
// Handles alphatab integration and file upload

document.addEventListener('DOMContentLoaded', function () {
  // File input and alphatab container
  const fileInput = document.getElementById('gp-upload');
  const alphaTabContainer = document.getElementById('alphaTab');
  let api;

  if (!fileInput || !alphaTabContainer) return;

  fileInput.addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;
    // Destroy previous instance if present
    if (api && typeof api.destroy === 'function') api.destroy();

    // Check for AlphaTab global
    const AlphaTabApi = (window.alphaTab && window.alphaTab.AlphaTabApi) ? window.alphaTab.AlphaTabApi : undefined;
    if (!AlphaTabApi) {
      alphaTabContainer.innerHTML = '<div style="color:red;padding:16px;">AlphaTab library failed to load. Please check your internet connection and disable browser extensions that may block scripts.</div>';
      return;
    }

    try {
      // Create the AlphaTab instance (without file) and then load the file explicitly
      api = new AlphaTabApi(alphaTabContainer, {
        player: {
          enablePlayer: true,
          enableCursor: true,
          enableLoop: true
        }
      });

      // Attach simple handlers if available to surface errors
      if (api.scoreLoaded && typeof api.scoreLoaded.on === 'function') {
        api.scoreLoaded.on(() => console.info('AlphaTab: score loaded'));
      }
      if (api.error && typeof api.error.on === 'function') {
        api.error.on((err) => {
          console.error('AlphaTab error', err);
          alphaTabContainer.innerHTML = '<div style="color:red;padding:16px;">AlphaTab error: ' + (err && err.message ? err.message : JSON.stringify(err)) + '</div>';
        });
      }

      // Load the uploaded file through AlphaTab's supported loader
      if (typeof api.load === 'function') {
        const reader = new FileReader();
        reader.onload = function(evt) {
          try {
            const uint8 = new Uint8Array(evt.target.result);
            api.load(uint8, function() {
              console.info('AlphaTab: score loaded');
            }, function(err) {
              console.error('AlphaTab load error', err);
              alphaTabContainer.innerHTML = '<div style="color:red;padding:16px;">Failed to load tab: ' + (err && err.message ? err.message : JSON.stringify(err)) + '</div>';
            });
          } catch (err) {
            console.error('AlphaTab file read/load error', err);
            alphaTabContainer.innerHTML = '<div style="color:red;padding:16px;">Failed to load tab: ' + (err && err.message ? err.message : JSON.stringify(err)) + '</div>';
          }
        };
        reader.onerror = function(evt) {
          console.error('Failed to read file', evt.target.error);
          alphaTabContainer.innerHTML = '<div style="color:red;padding:16px;">Failed to read file: ' + (evt.target.error && evt.target.error.message ? evt.target.error.message : 'Unknown error') + '</div>';
        };
        reader.readAsArrayBuffer(file);
      } else {
        console.error('AlphaTab API does not expose a supported load method');
        alphaTabContainer.innerHTML = '<div style="color:red;padding:16px;">AlphaTab API does not expose a supported file loader method.</div>';
      }
    } catch (err) {
      console.error('Failed to initialize AlphaTab:', err);
      alphaTabContainer.innerHTML = '<div style="color:red;padding:16px;">Failed to load tab: ' + (err.message || err) + '</div>';
    }
  });
});
