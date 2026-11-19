// Charts for a monitor detail page (FR-D4). Chart.js is served from /vendor (no CDN, CSP script-src 'self').
// Webhook: document age with the threshold as a line. Endpoint: response time, with failed checks marked.
(function () {
  var root = document.getElementById('chart-root');
  var canvas = document.getElementById('chart');
  var status = document.getElementById('chart-status');
  if (!root || !canvas || !window.Chart || !window.payMonitorApi) return;

  var config = JSON.parse(root.getAttribute('data-config'));
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim() || '#1f5fd1';
  var bad = style.getPropertyValue('--bad').trim() || '#b42318';
  var muted = style.getPropertyValue('--muted').trim() || '#5d6b7e';
  var chart;

  function label(iso) {
    // "11-18 14:05": always UTC, as the axis title says.
    return iso.slice(5, 10) + ' ' + iso.slice(11, 16);
  }

  function draw(points, thresholdMs) {
    var isWebhook = config.type === 'webhook';
    var labels = points.map(function (p) {
      return label(p.t);
    });
    var data = points.map(function (p) {
      return p.value === null ? null : isWebhook ? Math.round(p.value / 60000) : p.value;
    });
    var datasets = [
      {
        label: isWebhook ? 'Document age (minutes)' : 'Response time (ms)',
        data: data,
        borderColor: accent,
        backgroundColor: accent,
        spanGaps: true,
        pointRadius: points.length > 120 ? 0 : 3,
        pointBackgroundColor: points.map(function (p) {
          return p.isUp === false ? bad : accent;
        }),
        tension: 0.15,
      },
    ];
    if (isWebhook && typeof thresholdMs === 'number') {
      datasets.push({
        label: 'Threshold (minutes)',
        data: points.map(function () {
          return Math.round(thresholdMs / 60000);
        }),
        borderColor: bad,
        borderDash: [6, 4],
        pointRadius: 0,
      });
    }
    if (chart) chart.destroy();
    chart = new window.Chart(canvas, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        animation: false,
        scales: {
          x: { title: { display: true, text: 'Time (UTC)', color: muted } },
          y: {
            beginAtZero: true,
            title: { display: true, text: isWebhook ? 'Minutes' : 'Milliseconds', color: muted },
          },
        },
      },
    });
  }

  function load(range, from, to) {
    var url = config.seriesUrl + '?range=' + encodeURIComponent(range);
    if (range === 'custom') {
      url +=
        '&from=' + encodeURIComponent(from + 'T00:00:00Z') + '&to=' + encodeURIComponent(to + 'T23:59:59Z');
    }
    status.textContent = 'Loading…';
    window
      .payMonitorApi('GET', url)
      .then(function (payload) {
        var points = payload.data.points;
        status.textContent =
          points.length === 0 ? 'No checks in this range.' : points.length + ' point(s), times in UTC.';
        draw(points, payload.data.thresholdMs);
      })
      .catch(function (error) {
        status.textContent = error.message;
      });
  }

  document.getElementById('chart-controls').addEventListener('click', function (event) {
    var button = event.target instanceof Element ? event.target.closest('button[data-range]') : null;
    if (!button) return;
    var range = button.getAttribute('data-range');
    if (range === 'custom') {
      var from = document.getElementById('chart-from').value;
      var to = document.getElementById('chart-to').value;
      if (!from || !to) {
        status.textContent = 'Pick a start and an end date first.';
        return;
      }
      load('custom', from, to);
    } else {
      load(range);
    }
  });

  load('24h');
})();
