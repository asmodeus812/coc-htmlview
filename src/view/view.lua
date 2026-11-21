
local api = vim.api
local M = {}

local function notify(token, kind, ev)
    local payload = ev or {}
    payload.token = token
    payload.kind = kind
    pcall(vim.fn['coc#rpc#notify'], 'CocAutocmd', { 'HtmlviewEvent', payload })
end

local function text_width(win)
    local width = -1
    if win ~= -1 and api.nvim_win_is_valid(win) then
        local info = vim.fn.getwininfo(win)[1]
        width = info.width - info.textoff
    end
    return width
end

local function find_buf(name)
    local found = -1
    local full = vim.fn.fnamemodify(name, ':p')
    for _, b in ipairs(api.nvim_list_bufs()) do
        local bname = api.nvim_buf_get_name(b)
        if found == -1 and (bname == name or bname == full) then
            found = b
        end
    end
    return found
end

-- A taken name gets the view's token as suffix, the same as the Vim backend.
local function unique_name(name, token)
    local candidate = name
    if find_buf(name) ~= -1 then
        candidate = name .. ' [' .. token .. ']'
    end
    return candidate
end

local function set_buf_opts(buf)
    local o = { buf = buf }
    api.nvim_set_option_value('buftype', 'nofile', o)
    api.nvim_set_option_value('bufhidden', 'hide', o)
    api.nvim_set_option_value('swapfile', false, o)
    api.nvim_set_option_value('modifiable', false, o)
    api.nvim_set_option_value('filetype', 'htmlview', o)
end

local function set_win_opts(win, title, float)
    local o = { win = win, scope = 'local' }
    local label = ' ' .. title:gsub('%%', '%%%%')
    api.nvim_set_option_value('wrap', false, o)
    api.nvim_set_option_value('conceallevel', 2, o)
    api.nvim_set_option_value('concealcursor', 'nc', o)
    api.nvim_set_option_value('number', false, o)
    api.nvim_set_option_value('relativenumber', false, o)
    api.nvim_set_option_value('signcolumn', 'no', o)
    api.nvim_set_option_value('foldcolumn', '0', o)
    api.nvim_set_option_value('list', false, o)
    api.nvim_set_option_value('spell', false, o)
    if float then
        -- a borderless float has no frame for a title: the window bar carries it
        pcall(api.nvim_set_option_value, 'winbar', label, o)
    else
        api.nvim_set_option_value('statusline', label, o)
    end
end

local function float_config(o)
    local cols, rows = vim.o.columns, vim.o.lines - vim.o.cmdheight
    local width = math.max(20, math.floor(cols * o.floatWidth))
    local height = math.max(5, math.floor(rows * o.floatHeight))
    return {
        relative = 'editor',
        width = math.min(width, cols - 2),
        height = math.min(height, rows - 2),
        col = math.floor((cols - width) / 2),
        row = math.floor((rows - height) / 2),
        style = 'minimal',
        border = 'none',
    }
end

local function open_window(buf, o)
    local win = vim.fn.bufwinid(buf)
    if win ~= -1 then
        api.nvim_set_current_win(win)
    elseif o.mode == 'float' then
        win = api.nvim_open_win(buf, true, float_config(o))
    else
        vim.cmd(o.splitCommand)
        win = api.nvim_get_current_win()
        api.nvim_win_set_buf(win, buf)
    end
    local float = api.nvim_win_get_config(win).relative ~= ''
    set_win_opts(win, o.title, float)
    return win
end

local function clear_keys(buf)
    local ok, keys = pcall(api.nvim_buf_get_var, buf, 'htmlview_keys')
    if ok then
        for _, lhs in ipairs(keys) do
            pcall(vim.keymap.del, 'n', lhs, { buffer = buf })
        end
    end
end

local function close_windows(buf)
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do
        if not pcall(api.nvim_win_close, win, true) then
            api.nvim_win_call(win, function() vim.cmd('silent! bprevious') end)
        end
    end
end

--- Closes the view of buf: hides its windows, wipes it unless reused; notifies 'closed' exactly once.
function M.close(buf)
    if api.nvim_buf_is_valid(buf) then
        local reuse = vim.b[buf].htmlview_reuse
        local token = vim.b[buf].htmlview_token
        if reuse then
            pcall(api.nvim_del_augroup_by_name, 'htmlview_' .. buf)
            close_windows(buf)
            vim.b[buf].htmlview_token = nil
            notify(token, 'closed')
        else
            api.nvim_buf_delete(buf, { force = true })
        end
    end
    return true
end

local function install_keys(buf, keys, token)
    clear_keys(buf)
    local lhss = {}
    for _, k in ipairs(keys) do
        local action = k[2]
        vim.keymap.set('n', k[1], function()
            if action == 'close' then
                M.close(buf)
            else
                local cur = api.nvim_win_get_cursor(0)
                notify(token, 'key', { action = action, line = cur[1] - 1, col = cur[2] })
            end
        end, { buffer = buf, nowait = true, silent = true, desc = 'htmlview: ' .. action })
        table.insert(lhss, k[1])
    end
    api.nvim_buf_set_var(buf, 'htmlview_keys', lhss)
end

local function install_autocmds(buf, token)
    local group = api.nvim_create_augroup('htmlview_' .. buf, { clear = true })
    api.nvim_create_autocmd('BufWipeout', {
        group = group,
        buffer = buf,
        callback = function()
            pcall(api.nvim_del_augroup_by_id, group)
            notify(token, 'closed')
        end,
    })
    local function theme_changed()
        local win = vim.fn.bufwinid(buf)
        notify(token, 'colorscheme', { winid = win, width = text_width(win), background = vim.o.background })
    end
    api.nvim_create_autocmd('ColorScheme', { group = group, callback = theme_changed })
    -- A plain :set background changes the theme kind without a ColorScheme event.
    api.nvim_create_autocmd('OptionSet', { group = group, pattern = 'background', callback = theme_changed })
    api.nvim_create_autocmd('WinResized', {
        group = group,
        callback = function()
            for _, win in ipairs(vim.v.event.windows or {}) do
                if api.nvim_win_is_valid(win) and api.nvim_win_get_buf(win) == buf then
                    notify(token, 'resize', { winid = win, width = text_width(win), background = vim.o.background })
                end
            end
        end,
    })
    api.nvim_create_autocmd({ 'BufWinEnter', 'WinClosed' }, {
        group = group,
        callback = function(args)
            if args.event == 'WinClosed' or args.buf == buf then
                vim.schedule(function()
                    if api.nvim_buf_is_valid(buf) then
                        local win = vim.fn.bufwinid(buf)
                        notify(token, 'win', { winid = win, width = text_width(win), background = vim.o.background })
                    end
                end)
            end
        end,
    })
end

--- Opens or reuses the buffer and its window. o: name, reuse, mode, splitCommand, floatWidth, floatHeight, title,
--- token, keys ({lhs, action} pairs). Returns {bufnr, winid, width, background}.
function M.open(o)
    local buf = o.reuse and find_buf(o.name) or -1
    if buf ~= -1 then
        local old = vim.b[buf].htmlview_token
        if old ~= nil and old ~= o.token then
            notify(old, 'closed')
        end
    else
        buf = api.nvim_create_buf(false, true)
        api.nvim_buf_set_name(buf, unique_name(o.name, o.token))
    end
    set_buf_opts(buf)
    vim.b[buf].htmlview_reuse = o.reuse
    vim.b[buf].htmlview_token = o.token
    local win = open_window(buf, o)
    install_autocmds(buf, o.token)
    install_keys(buf, o.keys, o.token)
    return { bufnr = buf, winid = win, width = text_width(win), background = vim.o.background }
end

--- Window and theme state of buf: {winid, width, background}.
function M.state(buf)
    local win = vim.fn.bufwinid(buf)
    return { winid = win, width = text_width(win), background = vim.o.background }
end

local function to_rgb(n)
    return math.floor(n / 65536) % 256, math.floor(n / 256) % 256, n % 256
end

-- The canvas follows the window the view shows in: NormalFloat in a float, Normal in a split. Every colour that
-- derives from the canvas (the editor background variables, blends) then resolves against it.
local CANVAS = 'HtmlViewHostCanvas'

local function canvas_bg()
    local hl = api.nvim_get_hl(0, { name = CANVAS, link = false })
    local fallback = vim.o.background == 'light' and 0xffffff or 0x000000
    return hl.bg or fallback
end

local function blend(hex, alpha, base)
    local n = tonumber(hex:sub(2, 7), 16) or 0
    local r, g, b = to_rgb(n)
    local br, bgc, bb = to_rgb(base)
    local function mix(c, d) return math.floor(c * alpha + d * (1 - alpha) + 0.5) end
    return mix(r, br) * 65536 + mix(g, bgc) * 256 + mix(b, bb)
end

local function resolve_color(spec, base)
    local value = nil
    if type(spec) == 'string' then
        value = spec
    elseif spec.group ~= nil then
        -- the variable group first, then its fallbacks (groups a colorscheme may leave undefined)
        local groups = { spec.group }
        vim.list_extend(groups, spec.fallback or {})
        for _, name in ipairs(groups) do
            if value == nil then
                value = api.nvim_get_hl(0, { name = name, link = false })[spec.attr]
            end
        end
    else
        value = blend(spec.hex, spec.alpha, base)
    end
    return value
end

-- What htmlview last set per default group, as nvim_get_hl reads it back. A group still equal to it (or undefined)
-- is ours and follows a changed definition; anything else is the user's `:hi` and wins, like `hi def`. Global, so a
-- reloaded (upgraded) module still knows its earlier definitions.
_G.htmlview_hl_defaults = _G.htmlview_hl_defaults or {}
local defaults = _G.htmlview_hl_defaults

local function set_default(name, val)
    local current = api.nvim_get_hl(0, { name = name })
    if next(current) == nil or vim.deep_equal(current, defaults[name]) then
        api.nvim_set_hl(0, name, val)
        defaults[name] = api.nvim_get_hl(0, { name = name })
    end
end

--- Defines groups. specs: {name, link} or {name, attrs, colors} (see convert.ts). Links are the variable groups
--- (--vscode-* -> a standard group), the user's override point, so they keep default semantics (a user :hi wins).
--- Attribute groups come from the stylesheets and are always redefined in full, so a new sheet set, an edited
--- sheet or a changed colorscheme applies on the next update instead of the first definition winning.
function M.define(specs, float)
    local canvas = float and 'NormalFloat' or 'Normal'
    api.nvim_set_hl(0, CANVAS, { link = canvas })
    local base = canvas_bg()
    for _, s in ipairs(specs) do
        if s.name == CANVAS then
            -- set above from the window kind, not a default link
        elseif s.link ~= nil then
            local chosen = s.link
            if s.fallback ~= nil then
                for _, g in ipairs({ s.link, unpack(s.fallback) }) do
                    if next(api.nvim_get_hl(0, { name = g })) ~= nil then
                        chosen = g
                        break
                    end
                end
            end
            local val = { link = chosen }
            if s.only ~= nil then
                -- one attribute of the chain (a border's colour without its background)
                val = { [s.only] = api.nvim_get_hl(0, { name = chosen, link = false })[s.only] }
            end
            set_default(s.name, val)
        else
            local val = vim.deepcopy(s.attrs)
            for attr, spec in pairs(s.colors) do
                val[attr] = resolve_color(spec, base)
            end
            api.nvim_set_hl(0, s.name, val)
        end
    end
    return true
end

--- Places extmark tuples {line, col, endCol, group, priority, lineHl} in ns (invalid ones are skipped).
function M.marks(buf, ns, marks)
    for _, m in ipairs(marks) do
        local opts = { priority = m[5], strict = false }
        if m[6] == 1 then
            opts.line_hl_group = m[4]
        else
            opts.end_row = m[1]
            opts.end_col = m[3]
            opts.hl_group = m[4]
        end
        pcall(api.nvim_buf_set_extmark, buf, ns, m[1], m[6] == 1 and 0 or m[2], opts)
    end
    return true
end

local function chunks(list)
    local out = {}
    for _, c in ipairs(list) do
        out[#out + 1] = { c[1], c[2] }
    end
    return out
end

--- Places the engine's decorations in ns: virt_text {line, col, pos, chunks, priority, winCol, role}, virt_lines
--- {line, above, lines} and conceals {line, col, endCol, char}. Failures are skipped (strict = false, pcall).
function M.decor(buf, ns, d)
    for _, v in ipairs(d.virt or {}) do
        local opts = { virt_text = chunks(v[4]), virt_text_pos = v[3], priority = v[5], hl_mode = 'combine', strict = false }
        if v[6] >= 0 then
            opts.virt_text_pos = nil
            opts.virt_text_win_col = v[6]
        end
        local ok = pcall(api.nvim_buf_set_extmark, buf, ns, v[1], v[2], opts)
        if not ok and v[3] == 'inline' then
            -- Neovim < 0.10 has no inline virtual text: end-of-line for a link target, an overlay otherwise.
            opts.virt_text_pos = v[7] == 'link-target' and 'eol' or 'overlay'
            pcall(api.nvim_buf_set_extmark, buf, ns, v[1], v[2], opts)
        end
    end
    for _, v in ipairs(d.virtLines or {}) do
        local lines = {}
        for _, l in ipairs(v[3]) do
            lines[#lines + 1] = chunks(l)
        end
        pcall(api.nvim_buf_set_extmark, buf, ns, v[1], 0, { virt_lines = lines, virt_lines_above = v[2] == 1, strict = false })
    end
    for _, c in ipairs(d.conceals or {}) do
        pcall(api.nvim_buf_set_extmark, buf, ns, c[1], c[2], { end_row = c[1], end_col = c[3], conceal = c[4], strict = false })
    end
    return true
end

--- Replaces the content: lines, groups, then marks; keeps each window's cursor line (clamped).
function M.update(buf, ns, code_ns, lines, specs, marks, decor)
    if api.nvim_buf_is_valid(buf) then
        local cursors = {}
        for _, win in ipairs(vim.fn.win_findbuf(buf)) do
            cursors[win] = api.nvim_win_get_cursor(win)
        end
        api.nvim_set_option_value('modifiable', true, { buf = buf })
        api.nvim_buf_set_lines(buf, 0, -1, false, lines)
        api.nvim_set_option_value('modifiable', false, { buf = buf })
        api.nvim_set_option_value('modified', false, { buf = buf })
        api.nvim_buf_clear_namespace(buf, ns, 0, -1)
        api.nvim_buf_clear_namespace(buf, code_ns, 0, -1)
        local float = false
        for _, win in ipairs(vim.fn.win_findbuf(buf)) do
            float = float or api.nvim_win_get_config(win).relative ~= ''
        end
        M.define(specs, float)
        M.marks(buf, ns, marks)
        if decor ~= nil then
            M.decor(buf, ns, decor)
        end
        for win, cur in pairs(cursors) do
            local line = math.min(cur[1], math.max(1, #lines))
            pcall(api.nvim_win_set_cursor, win, { line, 0 })
        end
    end
    return true
end

--- Moves the cursor of buf's window to (line, byte col), 0-based line.
function M.cursor(buf, line, col)
    local win = vim.fn.bufwinid(buf)
    if win ~= -1 then
        pcall(api.nvim_win_set_cursor, win, { line + 1, col })
    end
    return true
end

--- Opens a URL with the system opener.
function M.open_url(href)
    local ok = pcall(vim.ui.open, href)
    if not ok then
        pcall(vim.fn['coc#ui#open_url'], href)
    end
    return true
end

return M
