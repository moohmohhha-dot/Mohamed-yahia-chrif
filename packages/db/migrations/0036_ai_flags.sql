-- AI layer switches (all off). ai.enabled is the master switch: off, no AI call is made anywhere.
-- Each feature also needs its own switch, for all stores or per store (docs/AI.md).
INSERT INTO feature_flags (key, description, enabled_by_default) VALUES
  ('ai.enabled', 'AI master switch: off = no call to the AI provider anywhere (every feature keeps working without AI)', false),
  ('ai.shopping_assistant', 'AI: shopping assistant (chat) for customers', false),
  ('ai.product_comparison', 'AI: written summary under product comparisons', false),
  ('ai.natural_language_search', 'AI: understand long search sentences the rules do not understand', false),
  ('ai.review_summaries', 'AI: summary of a product''s reviews (pros and cons)', false),
  ('ai.gift_recommendations', 'AI: understand a free-text gift description', false),
  ('ai.merchant_assistant', 'AI: assistant for merchants about their own sales and stock (all merchants)', false),
  ('ai.sales_analysis', 'AI: written analysis of a merchant''s sales (all merchants)', false),
  ('ai.product_classification', 'AI: suggest category, gender and concentration for a new product (all merchants)', false),
  ('ai.fraud_intelligence', 'AI: explanation of a customer''s risk signals for the fraud team (advice only)', false)
ON CONFLICT (key) DO NOTHING;
