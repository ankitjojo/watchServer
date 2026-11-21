// Progressive enhancement for the monitor forms. The server renders everything and validates
// everything; this script only hides the repeat interval unless it applies and offers "Validate key".
(function () {
  var mode = document.getElementById('alertMode');
  var group = document.getElementById('repeat-group');
  if (mode && group) {
    var sync = function () {
      group.hidden = mode.value !== group.getAttribute('data-show-for');
    };
    mode.addEventListener('change', sync);
    sync();
  }

  var button = document.getElementById('validate-key');
  var output = document.getElementById('validate-result');
  if (!button || !output || !window.payMonitorApi) return;

  // The API returns an ISO UTC instant; show it in the display zone (IST by default).
  function localTime(iso) {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: button.getAttribute('data-time-zone') || 'UTC',
      timeZoneName: 'short',
    });
  }

  button.addEventListener('click', function () {
    var collection = document.getElementById('sourceCollection');
    var key = document.getElementById('timestampKey');
    if (!collection || !key || !collection.value || !key.value) {
      output.textContent = 'Choose a collection and enter a timestamp key first.';
      return;
    }
    button.disabled = true;
    output.textContent = 'Checking…';
    window
      .payMonitorApi('POST', button.getAttribute('data-endpoint'), {
        sourceCollection: collection.value,
        timestampKey: key.value,
      })
      .then(function (payload) {
        var data = payload.data;
        if (data.valid) {
          output.textContent =
            'Valid' +
            (data.latestTimestamp ? ' (newest document: ' + localTime(data.latestTimestamp) + ')' : '') +
            (data.warning ? '. ' + data.warning : '.');
        } else {
          output.textContent = data.reason;
        }
      })
      .catch(function (error) {
        output.textContent = error.message;
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
