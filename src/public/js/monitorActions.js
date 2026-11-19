// Run check now, pause/resume and test email for a monitor (admin only; the server enforces it).
// No inline handlers (CSP): one delegated click listener on the actions panel.
(function () {
  var panel = document.getElementById('monitor-actions');
  if (!panel || !window.payMonitorApi) return;

  var type = panel.getAttribute('data-monitor-type');
  var id = panel.getAttribute('data-monitor-id');
  var output = panel.querySelector('[data-result]');

  function show(text, isError) {
    output.textContent = text;
    output.className = isError ? 'field-error' : 'muted';
  }

  function describeCheck(check) {
    var text = 'Result: ' + check.result + ' at ' + check.startedAtUtc + ' (' + check.durationMs + ' ms)';
    if (check.webhook && typeof check.webhook.ageMs === 'number') {
      text += '. Newest document is ' + Math.round(check.webhook.ageMs / 1000) + ' s old.';
    }
    if (check.endpoint) {
      text +=
        '. Attempts: ' +
        check.endpoint.attempts
          .map(function (a) {
            return a.statusCode ? 'HTTP ' + a.statusCode : a.errorMessage || 'no response';
          })
          .join(', ');
    }
    if (check.error) text += '. ' + check.error.message;
    return text;
  }

  panel.addEventListener('click', function (event) {
    var button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!button) return;
    var action = button.getAttribute('data-action');
    var buttons = panel.querySelectorAll('button[data-action]');
    buttons.forEach(function (b) {
      b.disabled = true;
    });
    show('Working…', false);

    window
      .payMonitorApi('POST', '/api/v1/monitors/' + type + '/' + id + '/' + action)
      .then(function (payload) {
        if (action === 'run') {
          show(describeCheck(payload.data), payload.data.result !== 'OK');
        } else if (action === 'test-email') {
          show('Test email queued. It is sent to the current recipients in a moment.', false);
        } else {
          // Pause and resume change what the page shows, so reload it.
          window.location.reload();
        }
      })
      .catch(function (error) {
        show(error.message, true);
      })
      .then(function () {
        buttons.forEach(function (b) {
          b.disabled = false;
        });
      });
  });
})();
