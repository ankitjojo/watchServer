// Resend a FAILED alert (admin only; the server enforces it). One delegated listener, no inline handlers (CSP).
(function () {
  if (!window.payMonitorApi) return;

  document.addEventListener('click', function (event) {
    var button = event.target instanceof Element ? event.target.closest('button[data-resend]') : null;
    if (!button) return;
    var id = button.getAttribute('data-resend');
    var result = document.querySelector('[data-resend-result="' + id + '"]');
    button.disabled = true;
    if (result) result.textContent = ' Queuing…';

    window
      .payMonitorApi('POST', '/api/v1/alerts/' + id + '/resend')
      .then(function () {
        // 202 means queued, not sent. Show the new status after a moment.
        if (result) result.textContent = ' Queued. Reloading…';
        window.setTimeout(function () {
          window.location.reload();
        }, 1200);
      })
      .catch(function (error) {
        button.disabled = false;
        if (result) {
          result.textContent = ' ' + error.message;
          result.className = 'field-error';
        }
      });
  });
})();
