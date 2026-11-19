// Small fetch wrapper for /api/v1 calls: adds the CSRF header and unwraps the response envelope.
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = meta ? meta.getAttribute('content') : '';

  window.payMonitorApi = function (method, url, body) {
    var headers = { Accept: 'application/json', 'x-csrf-token': csrfToken };
    var options = { method: method, headers: headers, credentials: 'same-origin' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (response) {
      return response.json().then(function (payload) {
        if (!payload.success) {
          var error = payload.error || {};
          var message =
            (error.message || 'Request failed') +
            (error.requestId ? ' (request ' + error.requestId + ')' : '');
          throw new Error(message);
        }
        return payload;
      });
    });
  };
})();
