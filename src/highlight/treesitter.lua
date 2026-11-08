
local bufnr, ns, priority, jobs = ...

local function char_len(byte)
  local len = 1
  if byte >= 0xF0 then
    len = 4
  elseif byte >= 0xE0 then
    len = 3
  elseif byte >= 0xC0 then
    len = 2
  end
  return len
end

local function cell_to_byte(line, cell)
  local cells, i = 0, 1
  local done = false
  while not done and i <= #line do
    local len = char_len(line:byte(i))
    local width = vim.fn.strdisplaywidth(line:sub(i, i + len - 1))
    if cells + width > cell then
      done = true
    else
      cells = cells + width
      i = i + len
    end
  end
  return i - 1
end

local function line_bases(job)
  local code = vim.split(job.text, "\n", { plain = true })
  local rows = vim.api.nvim_buf_get_lines(bufnr, job.startLine, job.startLine + #code, false)
  local bases = {}
  for r, text in ipairs(code) do
    local line = rows[r] or ""
    local base = cell_to_byte(line, job.startCol)
    if line:sub(base + 1, base + #text) ~= text then
      local found = line:find(text, 1, true)
      base = found and (found - 1) or nil
    end
    bases[r - 1] = base
  end
  return bases
end

local function has_parser(lang)
  local ok = pcall(vim.treesitter.language.add, lang)
  return ok and pcall(vim.treesitter.language.inspect, lang)
end

local function mark(job, bases, group, sr, sc, er, ec)
  local sb, eb = bases[sr], bases[er]
  if sb ~= nil and eb ~= nil then
    pcall(vim.api.nvim_buf_set_extmark, bufnr, ns, job.startLine + sr, sb + sc, {
      end_row = job.startLine + er,
      end_col = eb + ec,
      hl_group = group,
      priority = priority,
      strict = false,
    })
  end
end

local function highlight_tree(job, bases, tree, lang)
  local query = vim.treesitter.query.get(lang, "highlights")
  if query ~= nil then
    for id, node in query:iter_captures(tree:root(), job.text, 0, -1) do
      local name = query.captures[id]
      if name ~= nil and name:sub(1, 1) ~= "_" and name ~= "spell" and name ~= "nospell" and name ~= "conceal" then
        local sr, sc, er, ec = node:range()
        mark(job, bases, "@" .. name .. "." .. lang, sr, sc, er, ec)
      end
    end
  end
end

local function run_job(job)
  local handled = false
  if has_parser(job.lang) and vim.treesitter.query.get(job.lang, "highlights") ~= nil then
    local parser = vim.treesitter.get_string_parser(job.text, job.lang)
    parser:parse(true)
    local bases = line_bases(job)
    parser:for_each_tree(function(tree, ltree)
      highlight_tree(job, bases, tree, ltree:lang())
    end)
    handled = true
  end
  return handled
end

local handled = {}
if vim.treesitter ~= nil and vim.treesitter.get_string_parser ~= nil then
  for _, job in ipairs(jobs) do
    local ok, done = pcall(run_job, job)
    if ok and done then
      table.insert(handled, job.index)
    end
  end
end
return handled
