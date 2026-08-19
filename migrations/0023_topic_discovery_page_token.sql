-- Store YouTube search.list pagination token for For You load-more

ALTER TABLE topic_discovery_cache ADD COLUMN next_page_token TEXT;
