# python 3.9
# 计算Consusion Matrix、Accuracy、Prediction Map
# 灾中的inflow

import numpy as np
import pandas as pd
import pickle
import sys
from scipy.ndimage import gaussian_filter
from sklearn.metrics import confusion_matrix


sys.path.append('/usr/local/lib/python3.8/dist-packages')

if __name__ == '__main__':
    path = 'D:/LW/ABM'
    # path = '/remote-home/tls/wl/ABM'

    outputPath = path + '/OutputData'

    flow_type = 'inflow'
    granularity = '3km'
    shelter_weight = 0.1
    sigma = 1

    for city in ['zhengzhou', 'shenzhen']:
        basePath = outputPath + '/Result/' + city + '/' + 'shelter weight-' + str(shelter_weight) + '/' + granularity
        storagePath = basePath + '/sigma=' + str(sigma)

        model_input = pd.read_csv(basePath + '/model_input.csv', header=0)
        fids = model_input[model_input['Tid'] != -2]['FID'].tolist()  # 比arcmap的Fid大1
        tids = model_input[model_input['Tid'] != -2]['Tid'].tolist()
        # del model_input

        # params
        inputParam = pd.read_csv(basePath + '/inputParam.csv', index_col=0, header=None)
        generation = int(inputParam.iloc[0, 0])
        pop_discount = 1 / int(inputParam.iloc[1, 0])
        rows = int(inputParam.iloc[3, 0])
        cols = int(inputParam.iloc[4, 0])

        with open(basePath + '/Simul_env.pkl', 'rb') as file:
            env = pickle.load(file)

       
        tmp = env.rnd_data[0]
        gen_stab = -1
        for i in range(1, len(env.rnd_data)):
            if (env.rnd_data[i] == tmp).all():
                gen_stab = i-1    # 取稳定那一代
                break
            else:
                tmp = env.rnd_data[i]
        if gen_stab == -1:
            gen_stab = generation - 1

        # groundTruth
        groundTruth = np.zeros((rows, cols), dtype=float)  # 记录真值的趋势
        flow_dur_aveHour_map = np.zeros((rows, cols), dtype=float)

        i = 0
        j = rows - 1
        for ind, row in model_input.iterrows():
            if i == cols:
                j -= 1
                i = 0
            tid = row['Tid']
            if tid == -2:
                groundTruth[j, i] = np.nan  
                flow_dur_aveHour_map[j, i] = np.nan
            else:
                if row['Inflow_truth'] > 0:
                    groundTruth[j, i] = 1  # 增加
                else:
                    groundTruth[j, i] = -1  # 不变
                flow_dur_aveHour_map[j, i] = row['Inflow_truth']
            i += 1

        mask = np.isnan(groundTruth)

        if sigma != 0:
            sub_mask = flow_dur_aveHour_map == 0
            med = np.median(flow_dur_aveHour_map[~mask])
            flow_dur_aveHour_map[mask] = med
            flow_dur_aveHour_map = gaussian_filter(flow_dur_aveHour_map, sigma=sigma)
            flow_dur_aveHour_map[mask] = np.nan
            flow_dur_aveHour_map[sub_mask] = 0 

            groundTruth = np.zeros((rows, cols), dtype=float)  # 记录真值的趋势
            groundTruth[flow_dur_aveHour_map > 0] = 1
            groundTruth[flow_dur_aveHour_map == 0] = -1
            groundTruth[mask] = np.nan

        # 灾中3天
        flow_pred = np.load(basePath + '/Simul_' + flow_type + '.npy')
        flow_pred = flow_pred[:gen_stab + 1]
        flow_pred = flow_pred / pop_discount * 0.343
        flow_pred[0][mask] = np.nan

        flow_pred_sum = np.zeros((gen_stab + 1, rows, cols), dtype=float)
        flow_pred_ave = np.zeros((gen_stab + 1, rows, cols), dtype=float)
        prediction_label = np.full((gen_stab + 1, rows, cols), -1.0) 
        flow_pred_ave[0][mask] = np.nan
        prediction_label[0][mask] = np.nan

        accuracy = [0]
        cum_sub_mask = np.full((rows, cols), True)
        for gen in range(1, gen_stab+1):
            sub_mask = ~mask & (flow_pred[gen] == 0)
            cum_sub_mask = cum_sub_mask & sub_mask
            flow_pred[gen] = gaussian_filter(flow_pred[gen], sigma=sigma)
            flow_pred[gen][mask] = np.nan
            flow_pred[gen][cum_sub_mask] = 0

            flow_pred_sum[gen] = np.sum(flow_pred[:gen+1], axis=0) 
            flow_pred_ave[gen] = flow_pred_sum[gen] / gen
            m, n = np.where(flow_pred_ave[gen] > 0)
            prediction_label[gen][m, n] = 1

            prediction_label[gen][mask] = np.nan

            accuracy.append(np.sum(prediction_label[gen][~mask] == groundTruth[~mask]) / (np.sum(~mask)))

        a = groundTruth[~mask].flatten()
        b = (prediction_label[gen_stab][~mask]).flatten()
        c = pd.DataFrame(confusion_matrix(a, b, labels=[-1, 1]))

        # 存储CM和ACC
        c.to_csv(storagePath + '/' + flow_type + 'ConfusionMatrix.csv')
        np.save(storagePath + '/' + flow_type + 'Accuracy.npy', accuracy)

        # 存储
        n = len(tids)
        df = pd.DataFrame([[-1] * n, [-1] * n, [-1] * n, [-1] * n, [-1] * n], dtype=float).T
        df.columns = ['Tid', 'pred_label', 'pred_inflow', 'tru_label', 'tru_inflow']

        # 只需要Tid != -2的数据
        tmp_id = 0
        k = 1
        for i in range(rows):
            p = rows - 1 - i
            for j in range(cols):
                if k in fids:
                    ind = fids.index(k)
                    tid = tids[ind]
                    df.iloc[tmp_id, 0] = tid
                    df.iloc[tmp_id, 1] = prediction_label[gen_stab][p, j]
                    df.iloc[tmp_id, 2] = flow_pred_ave[gen_stab][p, j]
                    df.iloc[tmp_id, 3] = groundTruth[p, j]
                    df.iloc[tmp_id, 4] = flow_dur_aveHour_map[p, j]
                    tmp_id += 1
                k += 1
        df['Tid'] = df['Tid'].astype(int)

        df.to_csv(storagePath + '/' + flow_type + 'PredTru.csv', header=True, index=False) 

        # 存储
        np.save(storagePath + '/' + flow_type + 'GroundTruth_LabelMap.npy', groundTruth)    # label_map
        np.save(storagePath + '/' + flow_type + 'GroundTruth_Map.npy', flow_dur_aveHour_map)    # value_map
        np.save(storagePath + '/' + flow_type + 'Pred_LabelMap.npy', prediction_label) # label_map
        np.save(storagePath + '/' + flow_type + 'Pred_Map.npy', flow_pred_ave) # value_map

        print(city, gen_stab, accuracy[-1])


