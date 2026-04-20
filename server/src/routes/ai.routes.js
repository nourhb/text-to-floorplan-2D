import express from 'express';
import { createTextTo2dPlan } from '../controllers/textTo2dPlan.controller.js';

const router = express.Router();

router.post('/plan-2d', createTextTo2dPlan);

export default router;

