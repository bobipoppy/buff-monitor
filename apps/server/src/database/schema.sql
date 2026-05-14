CREATE TABLE IF NOT EXISTS items (
    id SERIAL PRIMARY KEY,
    goods_id INTEGER UNIQUE NOT NULL,
    name VARCHAR(500) NOT NULL,
    game VARCHAR(20) NOT NULL DEFAULT 'csgo',
    category VARCHAR(100),
    image_url TEXT,
    steam_price DECIMAL(12, 2),
    buff_min_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
    sell_count INTEGER NOT NULL DEFAULT 0,
    watch_priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_records (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    price DECIMAL(12, 2) NOT NULL,
    avg_price DECIMAL(12, 2),
    volume INTEGER NOT NULL DEFAULT 0,
    sell_count INTEGER NOT NULL DEFAULT 0,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portfolio (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    buy_price DECIMAL(12, 2) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    buy_date TIMESTAMP WITH TIME ZONE NOT NULL,
    target_price DECIMAL(12, 2),
    stop_loss_price DECIMAL(12, 2),
    sold_price DECIMAL(12, 2),
    sold_date TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'holding',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_rules (
    id SERIAL PRIMARY KEY,
    item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    portfolio_id INTEGER REFERENCES portfolio(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    condition VARCHAR(50) NOT NULL,
    threshold DECIMAL(12, 4) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_triggered_at TIMESTAMP WITH TIME ZONE,
    cooldown_minutes INTEGER NOT NULL DEFAULT 240,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_logs (
    id SERIAL PRIMARY KEY,
    rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    current_price DECIMAL(12, 2) NOT NULL,
    triggered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    notified BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_price_records_item_time ON price_records(item_id, recorded_at DESC);
CREATE INDEX idx_price_records_recorded_at ON price_records(recorded_at DESC);
CREATE INDEX idx_portfolio_status ON portfolio(status);
CREATE INDEX idx_portfolio_item ON portfolio(item_id);
CREATE INDEX idx_alert_rules_enabled ON alert_rules(enabled) WHERE enabled = true;
CREATE INDEX idx_alert_logs_triggered ON alert_logs(triggered_at DESC);
CREATE INDEX idx_items_game ON items(game);
CREATE INDEX idx_items_goods_id ON items(goods_id);
