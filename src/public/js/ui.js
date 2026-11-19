// Shared UI behaviour for every page (no inline handlers: CSP). One delegated listener per concern.
(function () {
  // Light / dark theme. tabler-theme.js applied the saved choice in <head>; this only switches it.
  document.addEventListener('click', function (event) {
    var button = event.target instanceof Element ? event.target.closest('[data-theme-toggle]') : null;
    if (!button) return;
    var next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-bs-theme', next);
    try {
      localStorage.setItem('tabler-theme', next);
    } catch (e) {
      // Storage can be blocked; the theme still applies for this page.
    }
  });

  // Loading state on form submit, so a slow save cannot be clicked twice.
  // Runs after confirm.js: a form waiting for confirmation was prevented and is skipped here.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
    var submit = event.submitter || form.querySelector('[type="submit"]');
    if (submit && !submit.classList.contains('dropdown-item')) {
      submit.classList.add('btn-loading');
      submit.setAttribute('aria-busy', 'true');
    }
    window.setTimeout(function () {
      if (submit) submit.disabled = true;
    }, 0);
  });

  // Client-side search and sort for small, unpaginated tables (data-table-tools). Paginated tables
  // (alerts log, check history) keep their server-side filters and paging instead.
  function cellValue(row, index) {
    var cell = row.cells[index];
    var text = cell ? (cell.getAttribute('data-sort-value') || cell.textContent || '').trim() : '';
    var number = Number(text.replace(/[^0-9.-]/g, ''));
    return { text: text.toLowerCase(), number: text !== '' && /^-?[0-9.,\s]+[a-z\s]*$/i.test(text) ? number : NaN };
  }

  document.querySelectorAll('table[data-table-tools]').forEach(function (table) {
    var body = table.tBodies[0];
    if (!body) return;
    var rows = Array.prototype.slice.call(body.rows);
    var search = document.querySelector('[data-table-search="' + table.id + '"]');
    var empty = document.querySelector('[data-table-empty="' + table.id + '"]');

    if (search) {
      search.addEventListener('input', function () {
        var query = search.value.trim().toLowerCase();
        var shown = 0;
        rows.forEach(function (row) {
          var match = query === '' || row.textContent.toLowerCase().indexOf(query) !== -1;
          row.hidden = !match;
          if (match) shown++;
        });
        if (empty) empty.hidden = shown !== 0;
      });
    }

    table.querySelectorAll('th[data-sortable]').forEach(function (th) {
      var index = th.cellIndex;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'table-sort';
      button.textContent = th.textContent;
      th.textContent = '';
      th.appendChild(button);
      th.setAttribute('aria-sort', 'none');
      button.addEventListener('click', function () {
        var ascending = th.getAttribute('aria-sort') !== 'ascending';
        table.querySelectorAll('th[data-sortable]').forEach(function (other) {
          other.setAttribute('aria-sort', 'none');
          var b = other.querySelector('.table-sort');
          if (b) b.classList.remove('asc', 'desc');
        });
        th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
        button.classList.add(ascending ? 'asc' : 'desc');
        rows.sort(function (a, b) {
          var x = cellValue(a, index);
          var y = cellValue(b, index);
          var result = !isNaN(x.number) && !isNaN(y.number) ? x.number - y.number : x.text.localeCompare(y.text);
          return ascending ? result : -result;
        });
        rows.forEach(function (row) {
          body.appendChild(row);
        });
      });
    });
  });
})();
